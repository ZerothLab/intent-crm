import { updateMember } from './member-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { IntentService, DomainError } from '../packages/domain/src/index.js';
import type { Actor, Plan } from '../packages/contracts/src/index.js';
const url=process.env.DATABASE_URL;
const rejectsCode=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(e:unknown)=>e instanceof DomainError&&e.code===code);
test('PostgreSQL domain: tenancy, atomic planning, exact approvals, dispatch ledger and management', {skip:!url}, async t=>{
 const db=createDatabase(url!),service=new IntentService(db),tenantId=`test_${randomUUID().replaceAll('-','')}`,otherId=`other_${randomUUID().replaceAll('-','')}`;
 const admin:Actor={tenantId,memberId:'admin',role:'admin'},sales:Actor={tenantId,memberId:'sales',role:'sales'},engineer:Actor={tenantId,memberId:'engineer',role:'engineer'};
 await migrate(db);
 await db.transaction(async tx=>{
  await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2),($3,$4)',[tenantId,'Domain tests',otherId,'Isolation tests']);
  for(const [tid,id,role] of [[tenantId,'admin','admin'],[tenantId,'sales','sales'],[tenantId,'engineer','engineer'],[otherId,'outsider','admin']])await tx.query('INSERT INTO members(tenant_id,id,name,email,role) VALUES($1,$2,$2,$3,$4)',[tid,id,`${id}@example.com`,role]);
  for(const [tid,id,owner] of [[tenantId,'customer','sales'],[tenantId,'technical','engineer'],[otherId,'private','outsider']])await tx.query("INSERT INTO customers(tenant_id,id,name,industry,contact,email,owner_id) VALUES($1,$2,$2,'Test','Test','customer@example.com',$3)",[tid,id,owner]);
  await tx.query("INSERT INTO model_connections(tenant_id,id,name,model,purpose) VALUES($1,'model','Fixture','fixture-v1','reasoning'),($1,'model_extraction','Fixture extraction','fixture-v1','extraction')",[tenantId]);
 });
 const makePlan=async(actor=admin)=>{
  const result=await service.addEvidence(actor,'customer',{title:`需求沟通 ${randomUUID()}`,body:'客户需要统一客户资料。预算为五十万元。希望下周确认方案。'});
  const plan:Plan={summary:'Fixture',facts:[{key:'requirements',value:'客户需要统一客户资料。',quote:'客户需要统一客户资料。',evidenceId:result.evidence.id}],proposal:{recipient:'customer@example.com',subject:'方案确认',body:'请确认需求；仅模拟投递。',evidenceIds:[result.evidence.id]}};
  return {...result,plan,action:await service.acceptPlan(tenantId,result.runId,plan)};
 };
 try{
  await t.test('fresh role and ownership deny forged role and cross-tenant context',async()=>{
   assert.equal((await service.listCustomers({...sales,role:'admin'})).length,1);
   await rejectsCode(service.getCustomer(sales,'technical'),'NOT_FOUND');await rejectsCode(service.getCustomer(admin,'private'),'NOT_FOUND');
   await rejectsCode(service.createMember({...sales,role:'admin'},{name:'Fake',email:'fake@example.com',role:'admin',active:true}),'FORBIDDEN');
   await assert.rejects(db.query("INSERT INTO customers(tenant_id,id,name,industry,contact,email,owner_id) VALUES($1,'cross','Cross','Test','Test','test@example.com','outsider')",[tenantId]),(e:unknown)=>(e as {code:string}).code==='23503');
  });
  await t.test('concurrent repeated imports return one evidence, run and outbox',async()=>{
   const input={kind:'meeting' as const,title:'重复导入检查',body:'客户需要统一客户资料。请避免重复导入后生成重复行动。'};
   const [first,second]=await Promise.all([service.addEvidence(admin,'customer',input),service.addEvidence(sales,'customer',input)]);
   assert.equal(first.evidence.id,second.evidence.id);assert.equal(first.runId,second.runId);
   assert.ok(!('sourceDigest' in first.evidence));
   const digestMatch=await db.query("SELECT source_digest=encode(sha256(convert_to(octet_length(kind)::text || ':' || kind || octet_length(title)::text || ':' || title || octet_length(body)::text || ':' || body,'UTF8')),'hex') AS matches FROM evidence WHERE tenant_id=$1 AND id=$2",[tenantId,first.evidence.id]);assert.equal(digestMatch.rows[0]!.matches,true);
   const replay=await service.addEvidence(admin,'customer',{...input,title:` ${input.title} `,body:` ${input.body} `});assert.equal(replay.runId,first.runId);
   const counts=await db.query('SELECT (SELECT count(*)::int FROM evidence WHERE tenant_id=$1 AND id=$2) AS evidence,(SELECT count(*)::int FROM planning_runs WHERE tenant_id=$1 AND evidence_id=$2) AS runs,(SELECT count(*)::int FROM outbox WHERE tenant_id=$1 AND aggregate_id=$3) AS outbox',[tenantId,first.evidence.id,first.runId]);assert.deepEqual(counts.rows[0],{evidence:1,runs:1,outbox:1});
   const sameBodyDifferentTitle=await service.addEvidence(admin,'customer',{...input,title:'另一场会议'});assert.notEqual(sameBodyDifferentTitle.runId,first.runId);
   const sameCustomerDifferentKind=await service.addEvidence(admin,'customer',{...input,kind:'note'});assert.notEqual(sameCustomerDifferentKind.runId,first.runId);
   const sameSourceDifferentCustomer=await service.addEvidence(admin,'technical',input);assert.notEqual(sameSourceDifferentCustomer.runId,first.runId);
  });
  await t.test('outbox selection skips an entire backed-off batch without dropping pending events',async()=>{
   const source=await service.addEvidence(admin,'customer',{title:'Outbox batch isolation',body:'Pending outbox records must remain durable while later work is selected.'});
   const ids=Array.from({length:101},()=>`evt_${randomUUID().replaceAll('-','')}`);
   try{
    for(let i=0;i<ids.length;i++)await db.query("INSERT INTO outbox(tenant_id,id,type,aggregate_id,payload,created_at) VALUES($1,$2,'plan.requested',$3,$4,'2000-01-01'::timestamptz+$5*interval '1 millisecond')",[tenantId,ids[i],source.runId,JSON.stringify({runId:source.runId}),i]);
    assert.deepEqual((await service.listOutbox(100)).map(event=>event.id),ids.slice(0,100));
    const later=await service.listOutbox(1,ids.slice(0,100));assert.equal(later[0]?.id,ids[100]);
    const pending=(await db.query('SELECT count(*)::int AS count FROM outbox WHERE id=ANY($1::text[]) AND published_at IS NULL',[ids])).rows[0]!.count;assert.equal(pending,101);
   }finally{await db.query('DELETE FROM outbox WHERE id=ANY($1::text[])',[ids]);}
  });
  await t.test('evidence+run+outbox are atomic; plan and facts are grounded and idempotent',async()=>{
   const evidence=await service.addEvidence(admin,'customer',{title:'会议',body:'客户需要统一客户资料，预算还未明确。'});
   const outbox=(await service.listOutbox(200)).filter(e=>e.tenantId===tenantId&&e.aggregateId===evidence.runId);assert.equal(outbox.length,1);
   const context=await service.getPlanningContext(tenantId,evidence.runId);assert.ok(context.evidence.some(e=>e.id===evidence.evidence.id));
   const invalid:Plan={summary:'Invalid',facts:[{key:'budget',value:'已批准一百万元',quote:'客户需要统一客户资料',evidenceId:evidence.evidence.id}],proposal:{recipient:'customer@example.com',subject:'Proposal',body:'Review',evidenceIds:[evidence.evidence.id]}};
   await rejectsCode(service.acceptPlan(tenantId,evidence.runId,invalid),'VALIDATION');assert.equal(await service.getActionForRun(tenantId,evidence.runId),null);
   const valid={...invalid,facts:[]};const first=await service.acceptPlan(tenantId,evidence.runId,valid);const replay=await service.acceptPlan(tenantId,evidence.runId,valid);assert.equal(first.id,replay.id);
   const detail=await service.getCustomer(admin,'customer');assert.equal(detail.customer.stage,'discovery');assert.ok(detail.facts.every(f=>f.status==='candidate'));
  });
  await t.test('run reads and plan citations cannot cross customer or tenant boundaries',async()=>{
   const otherActor:Actor={tenantId:otherId,memberId:'outsider',role:'admin'};
   const foreign=await service.addEvidence(otherActor,'private',{title:'Private evidence',body:'Only the other tenant may use this source.'});
   await rejectsCode(service.getRun(admin,foreign.runId),'NOT_FOUND');
   const local=await service.addEvidence(admin,'customer',{title:'Local citation check',body:'Only this customer context may contribute sources.'});
   const invalid:Plan={summary:'Invalid cross-tenant source',facts:[{key:'source',value:foreign.evidence.body,quote:foreign.evidence.body,evidenceId:foreign.evidence.id}],proposal:{recipient:'customer@example.com',subject:'Review',body:'Review sources',evidenceIds:[local.evidence.id,foreign.evidence.id]}};
   await rejectsCode(service.acceptPlan(tenantId,local.runId,invalid),'VALIDATION');
   const otherCustomer=await service.addEvidence(admin,'technical',{title:'Other customer evidence',body:'This evidence belongs to a different assigned customer.'});
   await rejectsCode(service.acceptPlan(tenantId,local.runId,{...invalid,facts:[],proposal:{...invalid.proposal,evidenceIds:[local.evidence.id,otherCustomer.evidence.id]}}),'VALIDATION');
   await rejectsCode(service.acceptPlan(tenantId,local.runId,{...invalid,proposal:{...invalid.proposal,evidenceIds:[local.evidence.id]}}),'VALIDATION');
   assert.equal(await service.getActionForRun(tenantId,local.runId),null);
  });
  await t.test('revision changes revoke approval; concurrent dispatch creates one receipt and commitment fulfillment',async()=>{
   const {action,runId}=await makePlan();await service.approveAction(admin,action.id,{expectedRevision:1});
   const edited=await service.updateAction(admin,action.id,{expectedRevision:1,recipient:action.recipient,subject:'审阅后的标题',body:action.body});assert.equal(edited.revision,2);assert.equal(edited.approvedRevision,null);
   assert.equal(await service.executeAction(tenantId,runId,1),'waiting_approval');await rejectsCode(service.approveAction(admin,action.id,{expectedRevision:1}),'CONFLICT');
   await service.approveAction(admin,action.id,{expectedRevision:2});await service.approveAction(admin,action.id,{expectedRevision:2});
   assert.deepEqual(await Promise.all([service.executeAction(tenantId,runId,2),service.executeAction(tenantId,runId,2)]),['succeeded','succeeded']);
   const complete=await service.getActionForRun(tenantId,runId);assert.ok(complete?.receipt?.simulated);assert.equal(complete?.operationId,action.operationId);
   const detail=await service.getCustomer(admin,'customer');const commitment=detail.commitments.find(c=>c.actionId===action.id);assert.equal(commitment?.status,'fulfilled');assert.equal(commitment?.completionReceiptId,complete?.receipt?.id);assert.equal(detail.customer.stage,'awaiting_review');
   const claims=await db.query("SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND event='dispatch.simulated.claimed'",[tenantId,action.id]);assert.equal(claims.rows[0]!.count,1);
  });
  await t.test('editing concurrently with dispatch cannot send the changed unapproved content',async()=>{
   const {action,runId}=await makePlan();await service.approveAction(admin,action.id,{expectedRevision:1});
   const [edit,dispatch]=await Promise.allSettled([service.updateAction(admin,action.id,{expectedRevision:1,recipient:action.recipient,subject:'尚未审批的新版本',body:'Do not send this revision without a new approval.'}),service.executeAction(tenantId,runId,1)]);
   assert.equal(dispatch.status,'fulfilled');const actual=await service.getActionForRun(tenantId,runId);assert.ok(actual);
   if(edit.status==='fulfilled'){assert.equal(actual.status,'draft');assert.equal(actual.revision,2);assert.equal(actual.receipt,null);assert.equal(actual.approvedRevision,null);}
   else{assert.ok(edit.reason instanceof DomainError);assert.equal(edit.reason.code,'CONFLICT');assert.equal(actual.status,'succeeded');assert.equal(actual.revision,1);assert.equal(actual.subject,action.subject);assert.ok(actual.receipt);}
  });
  await t.test('unknown outcome blocks redispatch; explicit reconciliation carries current revision',async()=>{
   const {action,runId}=await makePlan();await service.approveAction(admin,action.id,{expectedRevision:1});process.env.INTENT_TRANSPORT_OUTCOME='unknown';
   try{assert.equal(await service.executeAction(tenantId,runId,1),'unknown');}finally{delete process.env.INTENT_TRANSPORT_OUTCOME;}
   assert.equal(await service.executeAction(tenantId,runId,1),'unknown');assert.equal((await service.getActionForRun(tenantId,runId))?.receipt,null);
   await rejectsCode(service.approveAction(admin,action.id,{expectedRevision:1}),'CONFLICT');
   const draft=await service.reconcileAction(admin,action.id,{expectedRevision:1,outcome:'not_delivered',reference:'manual-check-001'});assert.equal(draft.revision,2);assert.equal(draft.status,'draft');
   const event=(await service.listOutbox(200)).find(e=>e.tenantId===tenantId&&e.aggregateId===runId&&e.type==='action.reconciled');assert.equal(event?.payload.revision,2);
   assert.equal(await service.executeAction(tenantId,runId,2),'waiting_approval');await service.approveAction(admin,action.id,{expectedRevision:2});assert.equal(await service.executeAction(tenantId,runId,2),'succeeded');
  });
  await t.test('delivered reconciliation makes one receipt and stale workflow state cannot undo completion',async()=>{
   const {action,runId}=await makePlan();await service.approveAction(admin,action.id,{expectedRevision:1});process.env.INTENT_TRANSPORT_OUTCOME='unknown';
   try{await service.executeAction(tenantId,runId,1);}finally{delete process.env.INTENT_TRANSPORT_OUTCOME;}
   const delivered=await service.reconcileAction(admin,action.id,{expectedRevision:1,outcome:'delivered',reference:'verified-reference-2'});assert.equal(delivered.status,'succeeded');assert.ok(delivered.receipt);
   await service.recordWorkflowState(tenantId,runId,'waiting_approval');assert.equal((await service.getRun(admin,runId)).status,'completed');assert.equal(await service.executeAction(tenantId,runId,1),'succeeded');
  });
  await t.test('model disable and initiating actor deactivation revoke approval before dispatch',async()=>{
   const first=await makePlan();await service.approveAction(admin,first.action.id,{expectedRevision:1});await service.updateModel(admin,'model',{enabled:false});
   assert.equal(await service.executeAction(tenantId,first.runId,1),'waiting_approval');assert.equal((await service.getActionForRun(tenantId,first.runId))?.approvedRevision,null);await service.updateModel(admin,'model',{enabled:true});
   const second=await makePlan(sales);await service.approveAction(admin,second.action.id,{expectedRevision:1});await updateMember(service,admin,'sales',{name:'Sales',email:'sales@example.com',role:'sales',active:false});
   assert.equal(await service.executeAction(tenantId,second.runId,1),'waiting_approval');await rejectsCode(service.getPlanningContext(tenantId,second.runId),'UNAUTHENTICATED');await updateMember(service,admin,'sales',{name:'Sales',email:'sales@example.com',role:'sales',active:true});
  });
  await t.test('extraction switch blocks context and plan acceptance until restored',async()=>{
   const evidence=await service.addEvidence(admin,'customer',{title:'Extraction gate',body:'客户需要提取已提供的需求，模型关闭时不得生成候选事实。'});
   const plan:Plan={summary:'Fixture extraction',facts:[],proposal:{recipient:'customer@example.com',subject:'Extraction review',body:'Review the extracted context.',evidenceIds:[evidence.evidence.id]}};
   try{
    await service.updateModel(admin,'model_extraction',{enabled:false});
    await rejectsCode(service.getPlanningContext(tenantId,evidence.runId),'MODEL_DISABLED');await rejectsCode(service.acceptPlan(tenantId,evidence.runId,plan),'MODEL_DISABLED');assert.equal(await service.getActionForRun(tenantId,evidence.runId),null);
    await service.updateModel(admin,'model_extraction',{enabled:true});assert.equal((await service.getPlanningContext(tenantId,evidence.runId)).model.purpose,'reasoning');const action=await service.acceptPlan(tenantId,evidence.runId,plan);
    await service.updateModel(admin,'model_extraction',{enabled:false});await service.approveAction(admin,action.id,{expectedRevision:1});assert.equal(await service.executeAction(tenantId,evidence.runId,1),'succeeded');
   }finally{await service.updateModel(admin,'model_extraction',{enabled:true});}
  });
  await t.test('a concurrent ownership change commits before dispatch authority is checked',async()=>{
   const {action,runId}=await makePlan();await service.approveAction(sales,action.id,{expectedRevision:1});
   const blocker=await db.pool.connect();let execution:Promise<unknown>|undefined;
   try{
    await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await blocker.query("UPDATE customers SET owner_id='engineer' WHERE tenant_id=$1 AND id='customer'",[tenantId]);
    execution=service.executeAction(tenantId,runId,1);
    const deadline=Date.now()+3000;let waiting=false;
    while(Date.now()<deadline){const locks=await db.query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[pid]);if(locks.rowCount){waiting=true;break;}await delay(10);}
    assert.ok(waiting,'execution must wait for the pending customer update');await blocker.query('COMMIT');assert.equal(await execution,'waiting_approval');
    const actual=await service.getActionForRun(tenantId,runId);assert.equal(actual?.receipt,null);assert.equal(actual?.approvedRevision,null);
   }finally{await blocker.query('ROLLBACK');blocker.release();if(execution)await execution;await db.query("UPDATE customers SET owner_id='sales' WHERE tenant_id=$1 AND id='customer'",[tenantId]);}
  });
  await t.test('approver role, activation and customer ownership are rechecked before dispatch',async()=>{
   const member={name:'Sales',email:'sales@example.com',role:'sales' as const,active:true};
   try{
    for(const change of ['deactivate','role','ownership'] as const){
     const {action,runId}=await makePlan();await service.approveAction(sales,action.id,{expectedRevision:1});
     if(change==='ownership')await db.query("UPDATE customers SET owner_id='engineer' WHERE tenant_id=$1 AND id='customer'",[tenantId]);
     else await updateMember(service,admin,'sales',{...member,...(change==='deactivate'?{active:false}:{role:'engineer'})});
     assert.equal(await service.executeAction(tenantId,runId,1),'waiting_approval');const rejected=await service.getActionForRun(tenantId,runId);assert.equal(rejected?.receipt,null);assert.equal(rejected?.approvedRevision,null);assert.equal(rejected?.revision,2);
     await updateMember(service,admin,'sales',member);await db.query("UPDATE customers SET owner_id='sales' WHERE tenant_id=$1 AND id='customer'",[tenantId]);
    }
   }finally{await updateMember(service,admin,'sales',member);await db.query("UPDATE customers SET owner_id='sales' WHERE tenant_id=$1 AND id='customer'",[tenantId]);}
  });
  await t.test('engineers can read assigned customer fields but cannot mutate them with a forged role',async()=>{
   await service.createField(admin,{key:'reviewer_notes',label:'Reviewer notes',type:'text',required:false,enabled:true,options:[]});
   const before=await service.getCustomer(engineer,'technical');
   await rejectsCode(service.updateFieldValues({...engineer,role:'admin'},'technical',{expectedRevision:before.customer.revision,values:{reviewer_notes:'Unauthorized edit'}}),'FORBIDDEN');
   const after=await service.getCustomer(engineer,'technical');assert.equal(after.customer.revision,before.customer.revision);assert.equal(after.fieldValues.reviewer_notes,undefined);
   const edited=await service.updateFieldValues(admin,'technical',{expectedRevision:before.customer.revision,values:{reviewer_notes:'Manager verified'}});assert.equal(edited.fieldValues.reviewer_notes,'Manager verified');
  });
  await t.test('field values validate types, required values and revisions; disable retains existing values',async()=>{
   const f=await service.createField(admin,{key:'budget',label:'Budget',type:'number',required:true,enabled:true,options:[]});let detail=await service.getCustomer(admin,'customer');
   await rejectsCode(service.updateFieldValues(admin,'customer',{expectedRevision:detail.customer.revision,values:{}}),'VALIDATION');await rejectsCode(service.updateFieldValues(admin,'customer',{expectedRevision:detail.customer.revision,values:{budget:'50'}}),'VALIDATION');
   detail=await service.updateFieldValues(admin,'customer',{expectedRevision:detail.customer.revision,values:{budget:50}});assert.equal(detail.fieldValues.budget,50);
   await rejectsCode(service.updateFieldValues(admin,'customer',{expectedRevision:detail.customer.revision-1,values:{budget:60}}),'CONFLICT');
   await rejectsCode(service.updateField(admin,f.id,{...f,type:'text'}),'VALIDATION');
   const input={key:f.key,label:f.label,type:f.type,required:f.required,enabled:f.enabled,options:f.options};await rejectsCode(service.updateField(admin,f.id,{...input,type:'text'}),'CONFLICT');
   await service.updateField(admin,f.id,{...input,enabled:false});assert.equal((await service.getCustomer(admin,'customer')).fieldValues.budget,50);
  });
  await t.test('required whitespace, reserved keys, options and invalid calendar dates are rejected',async()=>{
   const common={label:'Validation',type:'text' as const,required:false,enabled:true,options:[]};
   for(const key of ['constructor','prototype','__proto__'])await rejectsCode(service.createField(admin,{...common,key}),'VALIDATION');
   await service.createField(admin,{...common,key:'required_text',required:true});
   await service.createField(admin,{...common,key:'optional_number',type:'number'});
   await service.createField(admin,{...common,key:'review_date',type:'date'});
   await service.createField(admin,{...common,key:'review_choice',type:'select',options:['A','B']});
   let detail=await service.getCustomer(admin,'customer');
   await rejectsCode(service.updateFieldValues(admin,'customer',{expectedRevision:detail.customer.revision,values:{required_text:'  \n\t  '}}),'VALIDATION');
   detail=await service.updateFieldValues(admin,'customer',{expectedRevision:detail.customer.revision,values:{required_text:'Confirmed',optional_number:'  '}});assert.equal(detail.fieldValues.optional_number,null);
   const invalidValues:Record<string,string|number|null>[]=[{review_date:'2026-02-30'},{review_choice:'C'},{unknown_key:'value'},{budget:20}];
   for(const values of invalidValues)await rejectsCode(service.updateFieldValues(admin,'customer',{expectedRevision:detail.customer.revision,values}),'VALIDATION');
   // Legacy data must not read Object.prototype when a field value is absent.
   await db.query("INSERT INTO field_definitions(tenant_id,id,key,label,type) VALUES($1,'legacy_constructor','constructor','Legacy key','text')",[tenantId]);
   detail=await service.updateFieldValues(admin,'customer',{expectedRevision:detail.customer.revision,values:{review_date:'2026-02-28',review_choice:'A'}});assert.equal(detail.fieldValues.review_date,'2026-02-28');assert.equal(detail.fieldValues.review_choice,'A');
  });
  await t.test('engineering role cannot approve and concurrent demotion protects final admin',async()=>{
   const {action}=await makePlan();await rejectsCode(service.approveAction(engineer,action.id,{expectedRevision:1}),'FORBIDDEN');
   await rejectsCode(updateMember(service,admin,'admin',{name:'Admin',email:'admin@example.com',role:'sales',active:true}),'CONFLICT');
   const second=await service.createMember(admin,{name:'Second',email:'second@example.com',role:'admin',active:true});const secondActor:Actor={tenantId,memberId:second.id,role:'admin'};
   const results=await Promise.allSettled([updateMember(service,admin,'admin',{name:'Admin',email:'admin@example.com',role:'sales',active:true}),updateMember(service,secondActor,second.id,{name:'Second',email:'second@example.com',role:'sales',active:true})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   const count=await db.query("SELECT count(*)::int AS count FROM members WHERE tenant_id=$1 AND role='admin' AND active=true",[tenantId]);assert.equal(count.rows[0]!.count,1);
  });
 }finally{
  delete process.env.INTENT_TRANSPORT_OUTCOME;
  await db.transaction(async tx=>{
   for(const tid of [tenantId,otherId]){await tx.query('UPDATE planning_runs SET action_id=NULL WHERE tenant_id=$1',[tid]);for(const table of ['commitments','receipts','facts','outbox','actions','planning_runs','evidence','customer_field_values','field_definitions','customers','model_connections','audit_events','members'])await tx.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tid]);await tx.query('DELETE FROM tenants WHERE id=$1',[tid]);}
  });await db.close();
 }
});
