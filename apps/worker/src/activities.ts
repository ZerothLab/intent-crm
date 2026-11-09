import { ApplicationFailure } from '@temporalio/common';
import { DomainError, ModelSettingsService, type IntentService } from '@intent/domain';
import { FixtureModel, CompatibleModel, createModel } from '@intent/harness';
import type { IntentAction } from '@intent/contracts';
import type { ActionSnapshot, IntentActivities } from './types.js';
import { deliverViaGateway } from './gateway.js';

function snapshot(action: IntentAction): ActionSnapshot {
  return { actionId: action.id, revision: action.revision, approvedRevision: action.approvedRevision, status: action.status };
}

function safeFailure(error: unknown): ApplicationFailure {
  const permanent = error instanceof DomainError && error.status >= 400 && error.status < 500;
  // Database/validation errors can embed statements or source content: never preserve the cause.
  return ApplicationFailure.create({
    message: permanent ? `Intent command rejected (${error.code})` : 'Intent activity temporarily unavailable',
    type: permanent ? error.code : 'IntentActivityUnavailable',
    nonRetryable: permanent,
  });
}

export function createActivities(service: IntentService, model?:FixtureModel): IntentActivities {
  return {
    async plan(input) {
      try {
        const existing = await service.getActionForRun(input.tenantId, input.runId);
        if (existing) return snapshot(existing);
        await service.recordWorkflowState(input.tenantId, input.runId, 'planning');
        const context = await service.getPlanningContext(input.tenantId, input.runId);
        const settings=new ModelSettingsService(service.db);
        const reasoner=model??(context.model.provider==='fixture'?new FixtureModel():createModel(await settings.runtime(input.tenantId,context.model.id,context.model.revision)));
        const extraction=context.extractionModel??context.model;
        const extractor=model??(extraction.provider==='fixture'?new FixtureModel():createModel(await settings.runtime(input.tenantId,extraction.id,extraction.revision)));
        const generationFailure=()=>new DomainError(context.model.provider==='fixture'&&extraction.provider==='fixture'?'INVALID_FIXTURE_PLAN':'MODEL_GENERATION_FAILED',400,'Model generation failed. Check the connection and retry the run.');
        let facts,plan;
        try{
          const extractionContext={...context,model:extraction};
          facts=extractor instanceof CompatibleModel?await extractor.extract(extractionContext):(await extractor.plan(extractionContext)).facts;
        }catch{throw generationFailure();}
        const completed=await service.getActionForRun(input.tenantId,input.runId);
        if(completed)return snapshot(completed);
        // Extraction may outlive a permission, model or customer change.
        const current=await service.getPlanningContext(input.tenantId,input.runId);
        const currentExtraction=current.extractionModel??current.model;
        if(current.run.status==='failed'||current.model.id!==context.model.id||current.model.revision!==context.model.revision||currentExtraction.id!==extraction.id||currentExtraction.revision!==extraction.revision)
          throw new DomainError('CONFLICT',409,'Planning context changed during extraction.');
        try{
          const reviewedFacts=(current.facts??[]).filter(f=>f.status!=='candidate');
          const candidates=facts.map((f,i)=>({...f,id:`candidate_${i}`,customerId:current.customer.id,status:'candidate' as const,revision:1,reviewedBy:null,reviewNote:null,reviewedAt:null}));
          plan=await reasoner.plan({...current,facts:[...reviewedFacts,...candidates,...(current.facts??[]).filter(f=>f.status==='candidate')]});
        }catch{throw generationFailure();}
        return snapshot(await service.acceptPlan(input.tenantId,input.runId,{...plan,facts},[context.model,extraction]));
      } catch (error) {
        if (error instanceof DomainError && error.status >= 400 && error.status < 500) {
          try {
            await service.failRun(input.tenantId, input.runId, 'Planning failed. Check access permissions and model configuration.');
          } catch (recordError) {
            throw safeFailure(recordError);
          }
        }
        throw safeFailure(error);
      }
    },
    async readAction(input) {
      try {
        const action = await service.getActionForRun(input.tenantId, input.runId);
        if (!action) throw new DomainError('NOT_FOUND', 404, 'Action is unavailable');
        return snapshot(action);
      } catch (error) {
        throw safeFailure(error);
      }
    },
    async execute(input) {
      try {
        return await service.executeAction(input.tenantId, input.runId, input.expectedRevision, deliverViaGateway);
      } catch (error) {
        throw safeFailure(error);
      }
    },
  };
}
