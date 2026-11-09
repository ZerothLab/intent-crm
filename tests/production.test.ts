import { updateMember } from './member-helper.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '../packages/database/src/index.js';
import { IntentService, ProductService, CommercialService, ModelSettingsService, DeliveryService, DomainError } from '../packages/domain/src/index.js';
import { FixtureModel, CompatibleModel, isPublicAddress } from '../packages/harness/src/index.js';
import { decryptSecret } from '../packages/domain/src/model-settings.js';
import type { Actor, CustomerDetail, ModelConnection } from '../packages/contracts/src/index.js';

const rejects=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(error:unknown)=>error instanceof DomainError&&error.code===code);
const date=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format();

test('compatible provider sends grounded multi-turn context and rejects incomplete or invalid JSON',async()=>{
 const connection:ModelConnection={id:'m',name:'Custom',provider:'openai-compatible',model:'custom-model',purpose:'reasoning',enabled:true,baseUrl:'https://models.example.test/v1',timeoutMs:12000};
 const detail:CustomerDetail={customer:{id:'c',name:'Acme',industry:'Manufacturing',contact:'Buyer',email:'buyer@example.test',ownerId:'a',stage:'discovery',revision:1},evidence:[],facts:[],actions:[],commitments:[],fields:[],fieldValues:{}};
 const payloads:unknown[]=[];
 const model=new CompatibleModel({connection,apiKey:'test-only'},async(url,body,headers,timeout)=>{
  assert.equal(url,'https://models.example.test/v1/chat/completions');assert.equal(headers.authorization,'Bearer test-only');assert.equal(timeout,12000);payloads.push(body);
  return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'Please provide source evidence.',sources:[],cards:[]})}}]};
 });
 const reply=await model.reply(detail,'What changed?',[],[],[{id:'t',requestId:randomUUID(),message:'Earlier customer question',reply:{model:'custom-model',text:'Earlier answer',sources:[],cards:[]},createdAt:new Date().toISOString()}],'zh-CN');
 assert.equal(reply.model,'custom-model');const serialized=JSON.stringify(payloads);assert.match(serialized,/Earlier customer question/);assert.match(serialized,/Earlier answer/);assert.match(serialized,/Simplified Chinese/);assert.match(serialized,/untrusted data/);assert.ok(!serialized.includes('test-only'));
 for(const content of ['not JSON',JSON.stringify({text:'Invalid',sources:[],cards:[],command:'send'})])await assert.rejects(new CompatibleModel({connection,apiKey:'test'},async()=>({choices:[{finish_reason:'stop',message:{content}}]})).reply(detail,'Question',[],[]));
 await assert.rejects(new CompatibleModel({connection,apiKey:'test'},async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})).test());
});
test('outbound network policy rejects private, reserved and mapped addresses',()=>{
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','172.16.0.1','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2002:7f00:1::'])assert.equal(isPublicAddress(address),false,address);
 assert.equal(isPublicAddress('1.1.1.1'),true);assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
});
test('production lifecycle keeps credentials, authority, dispatch and financial corrections closed',{skip:!process.env.DATABASE_URL},async t=>{
 const db=createDatabase(process.env.DATABASE_URL!);const intent=new IntentService(db),product=new ProductService(db),commercial=new CommercialService(db),models=new ModelSettingsService(db),delivery=new DeliveryService(db);
 const tenantId=`prod_${randomUUID().replaceAll('-','')}`;const admin:Actor={tenantId,memberId:'admin',role:'admin'},sales:Actor={tenantId,memberId:'sales',role:'sales'};
 const previousKey=process.env.INTENT_ENCRYPTION_KEY,previousHosts=process.env.INTENT_DELIVERY_ALLOWED_HOSTS;
 process.env.INTENT_ENCRYPTION_KEY=randomBytes(32).toString('base64');process.env.INTENT_DELIVERY_ALLOWED_HOSTS='mail.example.test';
 await db.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenantId,'Production test workspace']);
 await db.query("INSERT INTO members(tenant_id,id,name,email,role) VALUES($1,'admin','Administrator','admin@example.test','admin'),($1,'sales','Sales A','a@example.test','sales'),($1,'next','Sales B','b@example.test','sales')",[tenantId]);
 await db.query("INSERT INTO model_connections(tenant_id,id,name,model,purpose) VALUES($1,'reasoning','Demo reasoning','fixture-v1','reasoning'),($1,'extraction','Demo extraction','fixture-v1','extraction')",[tenantId]);
 const newCustomer=()=>product.createCustomer(admin,{name:`Customer ${randomUUID()}`,industry:'Manufacturing',contact:'Buyer',email:'buyer@example.test',ownerId:'sales'});
 async function newAction(){const customer=await newCustomer();const source=await intent.addEvidence(sales,customer.id,{kind:'meeting',title:'Requirements discussion',body:'The customer needs a clear implementation plan and a budget review.'});const context=await intent.getPlanningContext(tenantId,source.runId);const action=await intent.acceptPlan(tenantId,source.runId,await new FixtureModel().plan(context));return {customer,source,action};}
 try{
  await t.test('encrypted settings, exact revision testing, one active model and fresh roles',async()=>{
   const key=`provider_${randomBytes(24).toString('hex')}`;
   const input={name:'DeepSeek reasoning',provider:'deepseek' as const,model:'deepseek-flash',purpose:'reasoning' as const,baseUrl:'https://api.deepseek.com',apiKey:key};
   await rejects(models.save({...sales,role:'admin'},input),'FORBIDDEN');
   const saved=await models.save(admin,input);assert.equal(saved.enabled,false);assert.equal(saved.hasApiKey,true);
   const row=(await db.query('SELECT credential FROM model_connections WHERE tenant_id=$1 AND id=$2',[tenantId,saved.id])).rows[0]!;
   assert.notEqual(row.credential,key);assert.ok(!JSON.stringify(await intent.listModels(admin)).includes(key));assert.throws(()=>decryptSecret(row.credential,`other:${saved.id}`));
   await rejects(intent.updateModel(admin,saved.id,{enabled:true,expectedRevision:saved.revision}),'MODEL_UNTESTED');
   await models.recordTest(admin,saved.id,saved.revision!,null);await intent.updateModel(admin,saved.id,{enabled:true,expectedRevision:saved.revision});
   const runtime=await models.forActor(sales);assert.equal(runtime.apiKey,key);assert.equal(runtime.connection.id,saved.id);assert.equal((await intent.listModels(admin)).filter(m=>m.purpose==='reasoning'&&m.enabled).length,1);
   const updated=await models.save(admin,{...input,name:'Updated',expectedRevision:saved.revision!},saved.id);assert.equal(updated.enabled,false);assert.equal(updated.testedRevision,null);
   await rejects(models.recordTest(admin,saved.id,saved.revision!,null),'CONFLICT');
   await rejects(models.save(admin,{...input,provider:'openai-compatible',baseUrl:'https://127.0.0.1/v1'}),'ENDPOINT_NOT_ALLOWED');
   await intent.updateModel(admin,'reasoning',{enabled:true});
  });
  await t.test('manager takeover recovers a disabled initiator without reusing approval',async()=>{
   const {action}=await newAction();await updateMember(intent,admin,'sales',{name:'Sales A',email:'a@example.test',role:'sales',active:false});
   await intent.approveAction(admin,action.id,{expectedRevision:action.revision});assert.equal(await intent.executeAction(tenantId,action.runId,action.revision),'waiting_approval');
   const invalidated=(await intent.listActions(admin)).find(a=>a.id===action.id)!;
   const taken=await intent.takeOverAction(admin,action.id,{expectedRevision:invalidated.revision,note:'Accepting responsibility after the employee left.'});assert.equal(taken.approvedRevision,null);assert.equal(taken.executionActorId,admin.memberId);
   await intent.approveAction(admin,action.id,{expectedRevision:taken.revision});assert.equal(await intent.executeAction(tenantId,action.runId,taken.revision),'succeeded');
   await updateMember(intent,admin,'sales',{name:'Sales A',email:'a@example.test',role:'sales',active:true});
  });
  await t.test('cancellation closes commitments and cannot produce a receipt',async()=>{
   const {action,customer}=await newAction();await intent.approveAction(admin,action.id,{expectedRevision:action.revision});
   const cancelled=await intent.cancelAction(admin,action.id,{expectedRevision:action.revision,note:'The customer no longer needs this proposal.'});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.receipt,null);
   await intent.executeAction(tenantId,action.runId,action.revision);const detail=await intent.getCustomer(admin,customer.id);assert.ok(detail.commitments.every(c=>c.status==='cancelled'));assert.equal(detail.actions[0]!.receipt,null);
   await rejects(intent.approveAction(admin,action.id,{expectedRevision:cancelled.revision}),'CONFLICT');
  });
  await t.test('atomic handover transfers open work, invalidates approvals and revokes prior customer access',async()=>{
   const {customer,source,action}=await newAction();const opportunity=await commercial.createOpportunity(sales,{customerId:customer.id,ownerId:'sales',title:'CRM implementation',amountCents:50000,expectedCloseDate:date(),stage:'proposal',forecastCategory:'commit',nextStep:'Review proposal',nextStepDueDate:date(),evidenceId:source.evidence.id,lostReason:null});
   const task=await commercial.createTask(admin,opportunity.id,{title:'Review implementation scope',assigneeId:'sales',dueDate:date()});await intent.approveAction(admin,action.id,{expectedRevision:action.revision});
   const moved=await product.handoverCustomer(admin,customer.id,{expectedRevision:customer.revision,ownerId:'next',note:'Transfer customer and active work to Sales B.'});assert.equal(moved.ownerId,'next');
   await rejects(intent.getCustomer(sales,customer.id),'NOT_FOUND');const next:Actor={tenantId,memberId:'next',role:'sales'};const detail=await commercial.getOpportunity(next,opportunity.id);assert.equal(detail.opportunity.ownerId,'next');assert.equal(detail.tasks[0]!.assigneeId,'next');assert.equal((await intent.getCustomer(next,customer.id)).actions[0]!.status,'draft');assert.equal(detail.history.length,2);
   await rejects(commercial.completeTask(next,task.id,{expectedRevision:task.revision,completionNote:'Stale version must not complete.'}),'CONFLICT');
   const changed=await commercial.updateTask(admin,task.id,{expectedRevision:detail.tasks[0]!.revision,assigneeId:'next',dueDate:date(),status:'cancelled',note:'No longer required.'});assert.equal(changed.status,'cancelled');
   const reopened=await commercial.updateTask(admin,task.id,{expectedRevision:changed.revision,assigneeId:'next',dueDate:date(),status:'open',note:'Required again after customer feedback.'});assert.equal(reopened.status,'open');
  });
  await t.test('real delivery claims once, records an honest receipt and deduplicates signed replies',async()=>{
   const settings=await delivery.save(admin,{expectedRevision:0,mode:'webhook',endpoint:'https://mail.example.test/send',sender:'sales@example.test',apiKey:'gateway-test-credential',webhookSecret:'test-signing-secret-with-more-than-32-characters'});assert.equal(settings.hasApiKey,true);
   const {action,customer}=await newAction();await intent.approveAction(admin,action.id,{expectedRevision:action.revision});let calls=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
   const first=intent.executeAction(tenantId,action.runId,action.revision,async()=>{calls++;entered();await gate;return {outcome:'delivered',reference:'gateway-delivery-001'};});await started;
   assert.equal(await intent.executeAction(tenantId,action.runId,action.revision,async()=>{calls++;return {outcome:'unknown'};}),'unknown');release();assert.equal(await first,'succeeded');assert.equal(calls,1);
   const completed=(await intent.getCustomer(admin,customer.id)).actions[0]!;assert.equal(completed.receipt?.simulated,false);
   const conflicting={eventId:'late_conflict',type:'delivery' as const,operationId:action.operationId,outcome:'not_delivered' as const,reference:'conflicting-provider-event'};
   await intent.receiveIntegrationEvent(tenantId,conflicting);await intent.receiveIntegrationEvent(tenantId,conflicting);
   const preserved=(await intent.getCustomer(admin,customer.id)).actions[0]!;assert.equal(preserved.receipt?.id,completed.receipt!.id);assert.match(preserved.lastError!,/conflicting provider/);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND event='dispatch.conflicting_event'",[tenantId,action.id])).rows[0]!.n,1);
   const event={eventId:'reply_001',type:'reply' as const,operationId:action.operationId,sender:action.recipient,title:'Customer feedback',body:'We need a revised implementation timeline before proceeding.'};
   const timestamp=String(Math.floor(Date.now()/1000)),raw=Buffer.from(JSON.stringify(event));const signature=createHmac('sha256','test-signing-secret-with-more-than-32-characters').update(timestamp).update('.').update(raw).digest('hex');
   await delivery.verify(tenantId,raw,timestamp,signature);await rejects(delivery.verify(tenantId,raw,timestamp,'0'.repeat(64)),'UNAUTHENTICATED');await rejects(delivery.verify(tenantId,raw,'1000000000',signature),'UNAUTHENTICATED');
   const response=await intent.receiveIntegrationEvent(tenantId,event);assert.deepEqual(await intent.receiveIntegrationEvent(tenantId,event),response);assert.ok(response.runId);assert.equal((await intent.getCustomer(admin,customer.id)).evidence.filter(e=>e.kind==='reply').length,1);
   await rejects(intent.receiveIntegrationEvent(tenantId,{...event,body:'Different contents must never reuse an event identifier.'}),'CONFLICT');
  });
  await t.test('uncertain dispatch never retries automatically and reconciliation creates a fresh operation',async()=>{
   const {action}=await newAction();await intent.approveAction(admin,action.id,{expectedRevision:1});let calls=0;const uncertain=async()=>{calls++;throw new Error('Connection lost after gateway accepted request');};
   assert.equal(await intent.executeAction(tenantId,action.runId,1,uncertain),'unknown');assert.equal(await intent.executeAction(tenantId,action.runId,1,uncertain),'unknown');assert.equal(calls,1);
   await rejects(intent.cancelAction(admin,action.id,{expectedRevision:1,note:'Cannot hide an uncertain outcome.'}),'CONFLICT');
   const resolved=await intent.reconcileAction(admin,action.id,{expectedRevision:1,outcome:'not_delivered',reference:'Verified gateway non-delivery'});assert.notEqual(resolved.operationId,action.operationId);assert.equal(resolved.approvedBy,null);
   await intent.approveAction(admin,action.id,{expectedRevision:resolved.revision});assert.equal(await intent.executeAction(tenantId,action.runId,resolved.revision,async()=>({outcome:'delivered',reference:'confirmed-second-attempt'})),'succeeded');
  });
  await t.test('financial reversal and contract cancellation preserve original records and frozen snapshots',async()=>{
   const customer=await newCustomer();const source=await intent.addEvidence(sales,customer.id,{title:'Correction authorization',body:'The signed contract and payment records require correction after an entry error.'});
   const opportunity=await commercial.createOpportunity(sales,{customerId:customer.id,ownerId:'sales',title:'Financial correction example',amountCents:10000,expectedCloseDate:date(),stage:'negotiation',forecastCategory:'commit',nextStep:'Verify contract',nextStepDueDate:date(),evidenceId:source.evidence.id,lostReason:null});
   const detail=await commercial.recordContract(admin,opportunity.id,{expectedRevision:1,amountCents:10000,signedDate:date(),reference:`contract-${randomUUID()}`,installments:[{amountCents:10000,dueDate:date()}]});
   const payment=await commercial.recordPayment(admin,detail.receivables[0]!.id,{amountCents:10000,paidDate:date(),reference:`payment-${randomUUID()}`});const snapshot=await commercial.captureSnapshot(admin,{period:date().slice(0,7),ownerId:null});
   await rejects(commercial.correctFinancialRecord(admin,'contract_cancelled',detail.contract!.id,{requestId:randomUUID(),note:'Wrong contract amount.',evidenceId:source.evidence.id}),'CONFLICT');
   const correction={requestId:randomUUID(),note:'Payment was entered against the wrong contract.',evidenceId:source.evidence.id};
   const reversed=await commercial.correctFinancialRecord(admin,'payment_reversed',payment.id,correction);assert.equal(reversed.receivables[0]!.remainingCents,10000);assert.ok(reversed.payments[0]!.reversedAt);
   await commercial.correctFinancialRecord(admin,'payment_reversed',payment.id,correction);assert.equal((await commercial.getOpportunity(admin,opportunity.id)).corrections?.length,1);
   const cancelled=await commercial.correctFinancialRecord(admin,'contract_cancelled',detail.contract!.id,{requestId:randomUUID(),note:'Replace incorrect contract registration.',evidenceId:source.evidence.id});assert.equal(cancelled.contract,null);assert.equal(cancelled.cancelledContracts?.length,1);assert.equal(cancelled.opportunity.stage,'negotiation');assert.equal(cancelled.receivables.length,0);
   const overview=await commercial.getOverview(admin,{period:date().slice(0,7)});assert.equal(overview.metrics.bookedCents,0);assert.equal(overview.metrics.collectedCents,0);assert.deepEqual((await commercial.listSnapshots(admin,{period:date().slice(0,7)}))[0]!.metrics,snapshot.metrics);
   await rejects(commercial.recordPayment(admin,detail.receivables[0]!.id,{amountCents:100,paidDate:date(),reference:'must-not-pay-cancelled'}),'CONFLICT');
  });
  await t.test('partial refunds, concurrent limits and corrections preserve net cash and historical ownership',async()=>{
   const customer=await newCustomer();const source=await intent.addEvidence(sales,customer.id,{title:'Refund confirmation',body:'The customer requests a documented refund for the returned service.'});
   const opportunity=await commercial.createOpportunity(sales,{customerId:customer.id,ownerId:'sales',title:'Refund example',amountCents:10000,expectedCloseDate:date(),stage:'negotiation',forecastCategory:'commit',nextStep:'Review refund',nextStepDueDate:date(),evidenceId:source.evidence.id,lostReason:null});
   const detail=await commercial.recordContract(admin,opportunity.id,{expectedRevision:1,amountCents:10000,signedDate:date(),reference:`contract-${randomUUID()}`,installments:[{amountCents:10000,dueDate:date()}]});
   const payment=await commercial.recordPayment(admin,detail.receivables[0]!.id,{amountCents:10000,paidDate:date(),reference:`payment-${randomUUID()}`});
   const input={requestId:randomUUID(),amountCents:6000,refundedDate:date(),reference:`refund-${randomUUID()}`,evidenceId:source.evidence.id,note:'Partial refund confirmed by the payment provider.'};
   await rejects(commercial.recordRefund({...sales,role:'admin'},payment.id,input),'FORBIDDEN');
   const results=await Promise.allSettled([commercial.recordRefund(admin,payment.id,input),commercial.recordRefund(admin,payment.id,{...input,requestId:randomUUID(),reference:`refund-${randomUUID()}`})]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const refund=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<CommercialService['recordRefund']>>>).value;
   const replay={...input,reference:refund.reference};assert.equal((await commercial.recordRefund(admin,payment.id,replay)).id,refund.id);
   assert.equal((await commercial.getOpportunity(admin,opportunity.id)).receivables[0]!.remainingCents,6000);
   assert.equal((await commercial.getOverview(admin,{period:date().slice(0,7)})).metrics.collectedCents,4000);
   await rejects(commercial.correctFinancialRecord(admin,'payment_reversed',payment.id,{requestId:randomUUID(),evidenceId:source.evidence.id,note:'Cannot erase a refunded payment.'}),'CONFLICT');
   await commercial.correctFinancialRecord(admin,'refund_reversed',refund.id,{requestId:randomUUID(),evidenceId:source.evidence.id,note:'Refund entry was incorrect; provider confirms no transfer.'});
   assert.equal((await commercial.getOpportunity(admin,opportunity.id)).receivables[0]!.remainingCents,0);
   await commercial.recordRefund(admin,payment.id,{...input,requestId:randomUUID(),reference:`refund-${randomUUID()}`,amountCents:10000});
   await commercial.correctFinancialRecord(admin,'contract_cancelled',detail.contract!.id,{requestId:randomUUID(),evidenceId:source.evidence.id,note:'Fully refunded contract is cancelled.'});
   assert.equal((await commercial.getOverview(admin,{period:date().slice(0,7)})).metrics.collectedCents,0);
   await commercial.recordContract(admin,opportunity.id,{expectedRevision:(await commercial.getOpportunity(admin,opportunity.id)).opportunity.revision,amountCents:10000,signedDate:date(),reference:`replacement-${randomUUID()}`,installments:[{amountCents:10000,dueDate:date()}]});
   assert.equal((await commercial.getOverview(admin,{period:date().slice(0,7)})).metrics.bookedCents,10000);
  });
  await t.test('runtime diagnostics are admin-only and recovery does not touch dispatched actions',async()=>{
   await rejects(intent.runtimeDiagnostics({...sales,role:'admin'}),'FORBIDDEN');await intent.heartbeat(`test_${tenantId}`);assert.equal((await intent.runtimeDiagnostics(admin)).worker,'healthy');
   const customer=await newCustomer();const {runId}=await intent.addEvidence(sales,customer.id,{title:'Stalled source',body:'The customer needs a documented next step.'});
   await rejects(intent.recoverRun(admin,{runId,note:'Too early to recover.'}),'CONFLICT');await db.query("UPDATE planning_runs SET created_at=now()-interval '10 minutes' WHERE tenant_id=$1 AND id=$2",[tenantId,runId]);
   await intent.recoverRun(admin,{runId,note:'Worker was offline; restart processing.'});const successor=await product.retryRun(admin,runId,{reason:'Recovered after worker restart.'});assert.equal(successor.parentRunId,runId);
   const context=await intent.getPlanningContext(tenantId,runId);await rejects(intent.acceptPlan(tenantId,runId,await new FixtureModel().plan(context)),'CONFLICT');
  });
 }finally{
  for(const table of ['financial_corrections','payment_refunds','inbound_events','dispatch_attempts','delivery_settings','advancement_proposals','opportunity_tasks','forecast_snapshots','sales_targets','payments','receivables','sales_contracts','opportunity_history','opportunities','conversation_turns','conversations','fact_reviews','commitments','receipts','facts','outbox','actions','planning_runs','evidence','customer_field_values','customers','field_definitions','model_connections','audit_events','identity_sessions','identity_credentials','members']){
   if(table==='actions')await db.query('UPDATE planning_runs SET action_id=NULL WHERE tenant_id=$1',[tenantId]);
   if(table==='receipts')await db.query('UPDATE commitments SET completion_receipt_id=NULL,status=\'cancelled\' WHERE tenant_id=$1',[tenantId]);
   await db.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenantId]);
  }
  await db.query('DELETE FROM tenants WHERE id=$1',[tenantId]);await db.query('DELETE FROM runtime_heartbeats WHERE id=$1',[`test_${tenantId}`]);await db.close();
  if(previousKey===undefined)delete process.env.INTENT_ENCRYPTION_KEY;else process.env.INTENT_ENCRYPTION_KEY=previousKey;if(previousHosts===undefined)delete process.env.INTENT_DELIVERY_ALLOWED_HOSTS;else process.env.INTENT_DELIVERY_ALLOWED_HOSTS=previousHosts;
 }
});
