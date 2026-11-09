import type { Connection } from './index.js';
import type { Opportunity } from '@intent/contracts';
/** Fixed October examples; rerunning never changes an existing opportunity or its business records. */
export async function seedCommercial(tx:Connection){
 const tenant='tenant_demo';
 const examples=[
  {id:'opp_demo_lanhai',customerId:'cus_lanhai',ownerId:'usr_zhaoshan',title:'【示例】蓝海客户协同平台',amountCents:48000000,stage:'negotiation',forecastCategory:'commit',expectedCloseDate:'2026-10-31',nextStep:'与采购负责人确认合同条款',nextStepDueDate:'2026-10-30',closedDate:null,lostReason:null},
  {id:'opp_demo_yuanchuan',customerId:'cus_yuanchuan',ownerId:'usr_liming',title:'【示例】远川销售流程升级',amountCents:32000000,stage:'proposal',forecastCategory:'best_case',expectedCloseDate:'2026-10-31',nextStep:'组织方案评审并明确决策人',nextStepDueDate:'2026-10-22',closedDate:null,lostReason:null},
  {id:'opp_demo_qinghe',customerId:'cus_qinghe',ownerId:'usr_liming',title:'【示例】青禾渠道数字化',amountCents:18000000,stage:'qualified',forecastCategory:'pipeline',expectedCloseDate:'2026-11-15',nextStep:'',nextStepDueDate:null,closedDate:null,lostReason:null},
  {id:'opp_demo_signed',customerId:'cus_lanhai',ownerId:'usr_zhaoshan',title:'【示例】蓝海一期实施服务',amountCents:24000000,stage:'won',forecastCategory:'excluded',expectedCloseDate:'2026-10-08',nextStep:'按合同里程碑推进交付',nextStepDueDate:'2026-11-01',closedDate:'2026-10-08',lostReason:null},
  {id:'opp_demo_lost',customerId:'cus_yuanchuan',ownerId:'usr_liming',title:'【示例】远川旧系统迁移',amountCents:20000000,stage:'lost',forecastCategory:'excluded',expectedCloseDate:'2026-10-18',nextStep:'',nextStepDueDate:null,closedDate:'2026-10-18',lostReason:'示例：客户调整本年度采购优先级'},
 ];
 for(const sample of examples){
  const initialDate=sample.closedDate??'2026-10-01';
  const initialTimestamp=`${initialDate}T09:00:00+08:00`;
  const inserted=await tx.query("INSERT INTO opportunities(tenant_id,id,customer_id,owner_id,title,amount_cents,expected_close_date,stage,forecast_category,next_step,next_step_due_date,closed_date,lost_reason,stage_entered_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$14) ON CONFLICT DO NOTHING RETURNING id",[tenant,sample.id,sample.customerId,sample.ownerId,sample.title,sample.amountCents,sample.expectedCloseDate,sample.stage,sample.forecastCategory,sample.nextStep,sample.nextStepDueDate,sample.closedDate,sample.lostReason,initialTimestamp]);
  if(!inserted.rowCount)continue;
  const names=(await tx.query('SELECT c.name AS customer_name,m.name AS owner_name FROM customers c JOIN members m ON m.tenant_id=c.tenant_id AND m.id=$3 WHERE c.tenant_id=$1 AND c.id=$2',[tenant,sample.customerId,sample.ownerId])).rows[0];
  const snapshot={...sample,currency:'CNY',customerName:names.customer_name,ownerName:names.owner_name,revision:1,stageEnteredAt:new Date(initialTimestamp).toISOString(),createdAt:new Date(initialTimestamp).toISOString(),updatedAt:new Date(initialTimestamp).toISOString(),evidenceId:null} as Opportunity;
  await tx.query("INSERT INTO opportunity_history(tenant_id,id,opportunity_id,revision,actor_id,note,after_state,created_at) VALUES($1,$2,$3,1,'usr_liming','固定2026年10月经营示例，不代表真实业务',$4,$5)",[tenant,`hist_${sample.id}`,sample.id,JSON.stringify(snapshot),initialTimestamp]);
  await tx.query("INSERT INTO audit_events(tenant_id,id,actor_id,event,entity_id,details) VALUES($1,$2,'usr_liming','commercial.example.seeded',$3,'{\"examplePeriod\":\"2026-10\"}')",[tenant,`aud_${sample.id}`,sample.id]);
  if(sample.id==='opp_demo_signed'){
   await tx.query("INSERT INTO sales_contracts(tenant_id,id,opportunity_id,customer_id,owner_id,amount_cents,signed_date,reference,created_at) VALUES($1,'contract_demo_lanhai',$2,$3,$4,24000000,'2026-10-08','EXAMPLE-CONTRACT-2026-10-001','2026-10-08T09:00:00+08:00')",[tenant,sample.id,sample.customerId,sample.ownerId]);
   await tx.query("INSERT INTO receivables(tenant_id,id,contract_id,opportunity_id,owner_id,due_date,amount_cents) VALUES($1,'recv_demo_lanhai_1','contract_demo_lanhai',$2,$3,'2026-10-20',12000000),($1,'recv_demo_lanhai_2','contract_demo_lanhai',$2,$3,'2026-11-20',12000000)",[tenant,sample.id,sample.ownerId]);
   await tx.query("INSERT INTO payments(tenant_id,id,receivable_id,contract_id,opportunity_id,owner_id,amount_cents,paid_date,reference,created_at) VALUES($1,'payment_demo_lanhai_1','recv_demo_lanhai_1','contract_demo_lanhai',$2,$3,6000000,'2026-10-15','EXAMPLE-PAYMENT-2026-10-001','2026-10-15T09:00:00+08:00')",[tenant,sample.id,sample.ownerId]);
  }
  if(sample.id==='opp_demo_qinghe')await tx.query("INSERT INTO opportunity_tasks(tenant_id,id,opportunity_id,title,assignee_id,due_date) VALUES($1,'task_demo_qinghe',$2,'【示例】确认实施资源与下一步计划','usr_wangchen','2026-10-26')",[tenant,sample.id]);
 }
 const target=await tx.query("INSERT INTO sales_targets(tenant_id,id,period,owner_id,bookings_target_cents,collection_target_cents) VALUES($1,'target_demo_2026_10','2026-10',NULL,120000000,60000000) ON CONFLICT DO NOTHING RETURNING id",[tenant]);
 if(target.rowCount)await tx.query("INSERT INTO audit_events(tenant_id,id,actor_id,event,entity_id,details) VALUES($1,'aud_target_demo_2026_10','usr_liming','commercial.example.seeded','target_demo_2026_10','{\"examplePeriod\":\"2026-10\"}')",[tenant]);
}
