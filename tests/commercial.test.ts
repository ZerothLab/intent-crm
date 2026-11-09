import { updateMember } from './member-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { seed } from '../packages/database/src/seed.js';
import { seedCommercial } from '../packages/database/src/seed-commercial.js';
import { CommercialService,IntentService,DomainError } from '../packages/domain/src/index.js';
import type { Actor,Opportunity } from '../packages/contracts/src/index.js';
const rejects=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(e:unknown)=>e instanceof DomainError&&e.code===code);
const input=(changes:Record<string,unknown>={})=>({title:'独立经营商机',customerId:'customer',ownerId:'sales',amountCents:10000,expectedCloseDate:'2026-10-31',stage:'proposal' as const,forecastCategory:'commit' as const,nextStep:'确认采购计划',nextStepDueDate:'2026-10-30',evidenceId:null,lostReason:null,...changes});
const edit=(o:Opportunity,changes:Record<string,unknown>={})=>({...input(),title:o.title,customerId:o.customerId,ownerId:o.ownerId,amountCents:o.amountCents,expectedCloseDate:o.expectedCloseDate,stage:o.stage,forecastCategory:o.forecastCategory,nextStep:o.nextStep,nextStepDueDate:o.nextStepDueDate,evidenceId:o.evidenceId,lostReason:o.lostReason,expectedRevision:o.revision,note:'更新经营信息',...changes});
test('PostgreSQL commercial commands preserve scope, history, money and concurrency',{skip:!process.env.DATABASE_URL},async t=>{
 const db=createDatabase(process.env.DATABASE_URL!),service=new CommercialService(db),intent=new IntentService(db);const tenantId=`commercial_${randomUUID().replaceAll('-','')}`,otherId=`commercial_other_${randomUUID().replaceAll('-','')}`;
 const admin:Actor={tenantId,memberId:'admin',role:'admin'},sales:Actor={tenantId,memberId:'sales',role:'sales'},engineer:Actor={tenantId,memberId:'engineer',role:'engineer'},manager:Actor={tenantId,memberId:'manager',role:'manager'},other:Actor={tenantId:otherId,memberId:'outsider',role:'admin'};
 await migrate(db);await db.transaction(async tx=>{
  await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2),($3,$4)',[tenantId,'Commercial tests',otherId,'Isolation tests']);
  for(const [tid,id,role]of[[tenantId,'admin','admin'],[tenantId,'manager','manager'],[tenantId,'sales','sales'],[tenantId,'sales_other','sales'],[tenantId,'engineer','engineer'],[otherId,'outsider','admin']])await tx.query('INSERT INTO members(tenant_id,id,name,email,role) VALUES($1,$2,$2,$3,$4)',[tid,id,`${id}@example.com`,role]);
  for(const [tid,id,owner]of[[tenantId,'customer','sales'],[tenantId,'second_customer','sales_other'],[tenantId,'technical','engineer'],[otherId,'private','outsider']])await tx.query("INSERT INTO customers(tenant_id,id,name,industry,contact,email,owner_id) VALUES($1,$2,$2,'Testing','Contact','customer@example.com',$3)",[tid,id,owner]);
 });
 const create=()=>service.createOpportunity(admin,input());
 const contract=async(opportunity:Opportunity,amount=10000)=>service.recordContract(admin,opportunity.id,{expectedRevision:opportunity.revision,amountCents:amount,signedDate:'2026-10-02',reference:`CONTRACT-${randomUUID()}`,installments:[{dueDate:'2026-10-20',amountCents:amount}]});
 try{
  await t.test('management without target reports null; forged role cannot access it',async()=>{
   const overview=await service.getOverview(admin,{period:'2026-10'});assert.equal(overview.target,null);assert.equal(overview.metrics.bookingAttainment,null);assert.equal(overview.metrics.collectionAttainment,null);assert.equal(overview.metrics.forecastGapCents,null);
   await rejects(service.getOverview({...sales,role:'admin'},{period:'2026-10'}),'FORBIDDEN');await rejects(service.getOverview(admin,{period:'2026-10',ownerId:'outsider'}),'VALIDATION');
  });
  await t.test('customer ownership, opportunity owner and source tenant are enforced',async()=>{
   const own=await service.createOpportunity(sales,input());assert.ok((await service.listOpportunities(sales)).some(o=>o.id===own.id));
   await rejects(service.createOpportunity(engineer,input({customerId:'technical',ownerId:'admin'})),'FORBIDDEN');await rejects(service.createOpportunity(sales,input({customerId:'second_customer'})),'NOT_FOUND');
   await rejects(service.createOpportunity(admin,input({customerId:'second_customer',ownerId:'sales'})),'NOT_FOUND');
   await rejects(service.updateOpportunity(sales,own.id,edit(own,{ownerId:'manager'})),'FORBIDDEN');const managed=await service.createOpportunity(admin,input({ownerId:'manager'}));await rejects(service.updateOpportunity(sales,managed.id,edit(managed)),'FORBIDDEN');
   const foreign=await service.createOpportunity(other,input({customerId:'private',ownerId:'outsider'}));await rejects(service.getOpportunity(admin,foreign.id),'NOT_FOUND');await rejects(service.createOpportunity(admin,input({ownerId:'outsider'})),'VALIDATION');
   const source=await intent.addEvidence(other,'private',{title:'Private source',body:'This source belongs to another tenant.'});await rejects(service.createOpportunity(admin,input({evidenceId:source.evidence.id})),'VALIDATION');
   const local=await intent.addEvidence(admin,'second_customer',{title:'Other customer source',body:'This source belongs to a different customer.'});await rejects(service.createOpportunity(admin,input({evidenceId:local.evidence.id})),'VALIDATION');
   await assert.rejects(db.query("INSERT INTO opportunities(tenant_id,id,customer_id,owner_id,title,amount_cents,expected_close_date,stage,forecast_category) VALUES($1,'bad_fk','private','sales','Bad FK',100,'2026-10-31','proposal','commit')",[tenantId]),(e:unknown)=>(e as {code:string}).code==='23503');
  });
  await t.test('independent opportunities keep full immutable history and exact revisions',async()=>{
   const first=await create(),second=await create();assert.notEqual(first.id,second.id);assert.equal(first.revision,1);
   const changed=await service.updateOpportunity(sales,first.id,edit(first,{amountCents:12000,note:'预算估算经人工核对'}));assert.equal(changed.revision,2);assert.equal(changed.stageEnteredAt,first.stageEnteredAt);
   await rejects(service.updateOpportunity(sales,first.id,edit(first,{title:'stale title'})),'CONFLICT');await rejects(service.updateOpportunity(admin,first.id,edit(changed,{customerId:'second_customer'})),'CONFLICT');
   const detail=await service.getOpportunity(admin,first.id);assert.equal(detail.history.length,2);assert.equal(detail.history[0]?.before?.amountCents,10000);assert.equal(detail.history[0]?.after.amountCents,12000);assert.equal(detail.history[1]?.after.amountCents,10000);assert.equal((await service.getOpportunity(admin,second.id)).opportunity.amountCents,10000);
  });
  await t.test('won requires contract; lost needs reason and can reopen with a note',async()=>{
   await rejects(service.createOpportunity(admin,input({stage:'won'})),'VALIDATION');await rejects(service.createOpportunity(admin,input({stage:'lost',lostReason:'No budget'})),'VALIDATION');const opportunity=await create();
   await rejects(service.updateOpportunity(admin,opportunity.id,edit(opportunity,{stage:'won'})),'VALIDATION');await rejects(service.updateOpportunity(admin,opportunity.id,edit(opportunity,{stage:'lost',lostReason:' '})),'VALIDATION');
   const lost=await service.updateOpportunity(admin,opportunity.id,edit(opportunity,{stage:'lost',lostReason:'客户停止本期采购',note:'已核实采购决策'}));assert.equal(lost.closedDate,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format());assert.ok(lost.stageEnteredAt>=opportunity.stageEnteredAt);
   const reopened=await service.updateOpportunity(admin,lost.id,edit(lost,{stage:'qualified',note:'客户重新批准调研'}));assert.equal(reopened.closedDate,null);assert.equal(reopened.lostReason,null);assert.equal((await service.getOpportunity(admin,lost.id)).history[1]?.after.stage,'lost');
  });
  await t.test('contract creation atomically balances installments, wins and freezes historical owner',async()=>{
   const opportunity=await create();const base={expectedRevision:1,amountCents:12000,signedDate:'2026-10-02',reference:`CONTRACT-${randomUUID()}`,installments:[{dueDate:'2026-10-20',amountCents:6000},{dueDate:'2026-11-20',amountCents:6000}]};
   await rejects(service.recordContract(sales,opportunity.id,base),'FORBIDDEN');await rejects(service.recordContract(admin,opportunity.id,{...base,amountCents:11000}),'VALIDATION');await rejects(service.recordContract(admin,opportunity.id,{...base,signedDate:'2099-01-01'}),'VALIDATION');await rejects(service.recordContract(admin,opportunity.id,{...base,installments:[{dueDate:'2026-10-01',amountCents:12000}]}),'VALIDATION');
   assert.equal((await service.getOpportunity(admin,opportunity.id)).contract,null);
   const booked=await service.recordContract(manager,opportunity.id,base);assert.equal(booked.opportunity.stage,'won');assert.equal(booked.opportunity.amountCents,12000);assert.equal(booked.opportunity.closedDate,'2026-10-02');assert.equal(booked.contract?.ownerId,'sales');assert.equal(booked.receivables.reduce((s,r)=>s+r.amountCents,0),12000);assert.equal(booked.history[0]?.before?.amountCents,10000);
   await rejects(service.updateOpportunity(admin,opportunity.id,edit(booked.opportunity,{ownerId:'manager'})),'CONFLICT');await rejects(service.recordContract(admin,opportunity.id,{...base,expectedRevision:2}),'CONFLICT');
   const duplicate=await create();await rejects(service.recordContract(admin,duplicate.id,{...base,expectedRevision:1}),'CONFLICT');assert.equal((await service.getOpportunity(admin,duplicate.id)).opportunity.stage,'proposal');
  });
  await t.test('payment retry is idempotent; mismatched references and concurrent overpayment fail',async()=>{
   const booked=await contract(await create());const receivable=booked.receivables[0]!;const data={amountCents:4000,paidDate:'2026-10-10',reference:`PAYMENT-${randomUUID()}`};
   const [a,b]=await Promise.all([service.recordPayment(admin,receivable.id,data),service.recordPayment(manager,receivable.id,data)]);assert.equal(a.id,b.id);assert.equal(a.paidDate,'2026-10-10');
   await rejects(service.recordPayment(admin,receivable.id,{...data,amountCents:3000}),'CONFLICT');await rejects(service.recordPayment(admin,receivable.id,{...data,reference:'PAY-FUTURE',paidDate:'2099-01-01'}),'VALIDATION');await rejects(service.recordPayment(admin,receivable.id,{...data,reference:'PAY-EARLY',paidDate:'2026-10-01'}),'VALIDATION');await rejects(service.recordPayment(sales,receivable.id,{...data,reference:'PAY-FORBIDDEN'}),'FORBIDDEN');
   const results=await Promise.allSettled([service.recordPayment(admin,receivable.id,{...data,amountCents:5000,reference:`PAY-A-${randomUUID()}`}),service.recordPayment(manager,receivable.id,{...data,amountCents:5000,reference:`PAY-B-${randomUUID()}`})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const failure=results.find(r=>r.status==='rejected');assert.ok(failure?.status==='rejected'&&failure.reason instanceof DomainError&&failure.reason.code==='CONFLICT');
   const detail=await service.getOpportunity(admin,booked.opportunity.id);assert.equal(detail.payments.length,2);assert.equal(detail.receivables[0]?.paidCents,9000);assert.equal(detail.receivables[0]?.remainingCents,1000);assert.equal(detail.contract?.amountCents,10000);await rejects(service.recordPayment(other,receivable.id,{...data,reference:'OTHER-TENANT'}),'NOT_FOUND');
  });
  await t.test('money is integer cents and calendar dates remain exact business dates',async()=>{
   await rejects(service.createOpportunity(admin,input({amountCents:12.5})),'VALIDATION');await rejects(service.createOpportunity(admin,input({amountCents:1_000_000_000_001})),'VALIDATION');await rejects(service.createOpportunity(admin,input({expectedCloseDate:'2026-02-30'})),'VALIDATION');
   const penny=await service.createOpportunity(admin,input({amountCents:1,expectedCloseDate:'2026-12-31'}));assert.equal(penny.amountCents,1);assert.equal(penny.expectedCloseDate,'2026-12-31');
  });
  await t.test('target updates require revision and concurrent creation cannot overwrite',async()=>{
   const data={period:'2026-10',ownerId:null,bookingsTargetCents:100000,collectionTargetCents:50000,expectedRevision:0};const results=await Promise.allSettled([service.saveTarget(admin,data),service.saveTarget(manager,{...data,bookingsTargetCents:120000})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const target=(await service.getOverview(admin,{period:'2026-10'})).target!;assert.equal(target.revision,1);
   await rejects(service.saveTarget(admin,data),'CONFLICT');const updated=await service.saveTarget(manager,{...data,expectedRevision:1,bookingsTargetCents:150000});assert.equal(updated.revision,2);assert.equal(updated.bookingsTargetCents,150000);await rejects(service.saveTarget(sales,{...data,period:'2026-11'}),'FORBIDDEN');
   assert.equal((await service.getOverview(admin,{period:'2026-11'})).target,null);assert.equal((await service.getOverview(admin,{period:'2026-10',ownerId:'manager'})).target,null);
  });
  await t.test('saved snapshots retain old forecast and compare only matching scope',async()=>{
   const opportunity=await service.createOpportunity(admin,input({ownerId:'manager',amountCents:20000}));const snapshot=await service.captureSnapshot(manager,{period:'2026-10',ownerId:'manager'});const saved=JSON.stringify(snapshot);
   await service.updateOpportunity(admin,opportunity.id,edit(opportunity,{amountCents:30000}));const overview=await service.getOverview(manager,{period:'2026-10',ownerId:'manager'});assert.equal(overview.snapshotDeltaCents,10000);assert.ok(overview.snapshotChanges.some(c=>c.opportunityId===opportunity.id&&c.kind==='changed'));
   assert.equal(JSON.stringify((await service.listSnapshots(admin,{period:'2026-10',ownerId:'manager'}))[0]),saved);assert.equal((await service.listSnapshots(admin,{period:'2026-11',ownerId:'manager'})).length,0);assert.equal((await service.listSnapshots(admin,{period:'2026-10'})).length,0);
  });
  await t.test('intervention tasks need accessible active assignee and completion does not win',async()=>{
   const opportunity=await service.createOpportunity(admin,input({customerId:'technical',ownerId:'admin',nextStep:'',nextStepDueDate:null}));await rejects(service.createTask(sales,opportunity.id,{title:'经理介入确认',assigneeId:'sales',dueDate:'2026-10-30'}),'FORBIDDEN');await rejects(service.createTask(manager,opportunity.id,{title:'经理介入确认',assigneeId:'sales',dueDate:'2026-10-30'}),'NOT_FOUND');
   const task=await service.createTask(manager,opportunity.id,{title:'技术负责人核实需求',assigneeId:'engineer',dueDate:'2026-10-30'});const complete=await service.completeTask(engineer,task.id,{expectedRevision:1,completionNote:'已与客户确认实施范围'});assert.equal(complete.status,'completed');assert.equal(complete.revision,2);await rejects(service.completeTask(engineer,task.id,{expectedRevision:1,completionNote:'重复提交'}),'CONFLICT');assert.equal((await service.getOpportunity(admin,opportunity.id)).opportunity.stage,'proposal');assert.ok((await service.getOverview(admin,{period:'2026-10'})).risks.some(r=>r.opportunityId===opportunity.id&&r.kind==='next_step_missing'));
  });
  await t.test('task completion rechecks ownership after a concurrent customer reassignment',async()=>{
   const opportunity=await service.createOpportunity(admin,input({customerId:'technical',ownerId:'admin'}));const task=await service.createTask(manager,opportunity.id,{title:'并发归属变更测试',assigneeId:'engineer',dueDate:'2026-10-30'});
   const blocker=await db.pool.connect();let completion:Promise<{value:unknown;error:unknown}>|undefined;
   try{
    await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;await blocker.query("UPDATE customers SET owner_id='sales_other' WHERE tenant_id=$1 AND id='technical'",[tenantId]);
    completion=service.completeTask(engineer,task.id,{expectedRevision:1,completionNote:'检查当前客户访问权限'}).then(value=>({value,error:null}),error=>({value:null,error}));
    let blocked=false;const deadline=Date.now()+3000;while(Date.now()<deadline){const locks=await db.query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[pid]);if(locks.rowCount){blocked=true;break;}await delay(10);}assert.ok(blocked,'completion must wait for the pending ownership change');await blocker.query('COMMIT');const outcome=await completion;assert.ok(outcome.error instanceof DomainError&&outcome.error.code==='NOT_FOUND');assert.equal((await service.getOpportunity(admin,opportunity.id)).tasks[0]?.status,'open');
   }finally{await blocker.query('ROLLBACK');blocker.release();if(completion)await completion;await db.query("UPDATE customers SET owner_id='engineer' WHERE tenant_id=$1 AND id='technical'",[tenantId]);}
  });
  await t.test('database constraints reject NULL loss and completion notes even outside commands',async()=>{
   const opportunity=await create();await assert.rejects(db.query("UPDATE opportunities SET stage='lost',closed_date='2026-10-20',lost_reason=NULL WHERE tenant_id=$1 AND id=$2",[tenantId,opportunity.id]),(error:unknown)=>(error as {code:string}).code==='23514');assert.equal((await service.getOpportunity(admin,opportunity.id)).opportunity.stage,'proposal');
   const task=await service.createTask(manager,opportunity.id,{title:'验证关闭说明约束',assigneeId:'sales',dueDate:'2026-10-30'});await assert.rejects(db.query("UPDATE opportunity_tasks SET status='completed',completed_at=now(),completion_note=NULL WHERE tenant_id=$1 AND id=$2",[tenantId,task.id]),(error:unknown)=>(error as {code:string}).code==='23514');assert.equal((await service.getOpportunity(admin,opportunity.id)).tasks[0]?.status,'open');
  });
  await t.test('revoked members cannot use a previously issued actor context',async()=>{
   const opportunity=await create();await updateMember(intent,admin,'sales',{name:'Sales',email:'sales@example.com',role:'sales',active:false});try{await rejects(service.updateOpportunity(sales,opportunity.id,edit(opportunity)),'UNAUTHENTICATED');await rejects(service.createOpportunity(admin,input()),'VALIDATION');}finally{await updateMember(intent,admin,'sales',{name:'Sales',email:'sales@example.com',role:'sales',active:true});}
  });
  await t.test('fixed commercial example seed is idempotent and preserves edits',async()=>{
   await seed(db);const first=await db.query("SELECT count(*)::int AS count FROM opportunities WHERE tenant_id='tenant_demo'");await seed(db);const second=await db.query("SELECT count(*)::int AS count FROM opportunities WHERE tenant_id='tenant_demo'");assert.equal(second.rows[0]!.count,first.rows[0]!.count);assert.ok(first.rows[0]!.count>=5);
   const payments=await db.query("SELECT amount_cents,paid_date FROM payments WHERE tenant_id='tenant_demo' AND id='payment_demo_lanhai_1'");assert.equal(Number(payments.rows[0]!.amount_cents),6000000);assert.equal(payments.rows[0]!.paid_date,'2026-10-15');
   const rollback=new Error('rollback isolated seed edit verification');await assert.rejects(db.transaction(async tx=>{await tx.query("UPDATE opportunities SET title='Preserved user edit',amount_cents=12345 WHERE tenant_id='tenant_demo' AND id='opp_demo_lanhai'");await seedCommercial(tx);const edited=(await tx.query("SELECT title,amount_cents FROM opportunities WHERE tenant_id='tenant_demo' AND id='opp_demo_lanhai'")).rows[0]!;assert.equal(edited.title,'Preserved user edit');assert.equal(Number(edited.amount_cents),12345);throw rollback;}),error=>error===rollback);
  });
 }finally{await db.transaction(async tx=>{for(const tid of[tenantId,otherId]){for(const table of['opportunity_tasks','forecast_snapshots','sales_targets','payments','receivables','sales_contracts','opportunity_history','opportunities'])await tx.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tid]);await tx.query('UPDATE planning_runs SET action_id=NULL WHERE tenant_id=$1',[tid]);for(const table of['commitments','receipts','facts','outbox','actions','planning_runs','evidence','customer_field_values','field_definitions','customers','model_connections','audit_events','members'])await tx.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tid]);await tx.query('DELETE FROM tenants WHERE id=$1',[tid]);}});await db.close();}
});
