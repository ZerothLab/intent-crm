import assert from 'node:assert/strict';
// Run only against an isolated acceptance workspace. This creates records and briefly
// disables its reasoning adapter to prove failure recovery through the real worker.
const base=process.env.INTENT_API_URL||'http://127.0.0.1:3100/api';
const origin=process.env.INTENT_PUBLIC_ORIGIN;
const workspaceId=process.env.INTENT_ACCEPTANCE_WORKSPACE;
const email=process.env.INTENT_ACCEPTANCE_EMAIL;
const password=process.env.INTENT_ACCEPTANCE_PASSWORD;
if(!origin||!workspaceId||!email||!password||process.env.INTENT_ACCEPTANCE_ALLOW_MUTATIONS!=='true')throw new Error('Provide acceptance workspace credentials, public origin and INTENT_ACCEPTANCE_ALLOW_MUTATIONS=true. Never target a real team.');
let cookie='';
async function request(path,body,method=body===undefined?'GET':'POST',status=body===undefined||method==='PATCH'?200:201){
 const response=await fetch(base+path,{method,headers:{origin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 const result=await response.json();assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(result)}`);
 if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return result;
}
async function until(path,condition){
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){const value=await request(path);if(condition(value))return value;await new Promise(r=>setTimeout(r,300));}
 throw new Error(`Timed out waiting for ${path}. Check Temporal and Worker.`);
}
const login=await request('/auth/login',{workspaceId,email,password});
const customer=await request('/customers',{name:`验收客户 ${new Date().toISOString()}`,industry:'企业服务',contact:'验收联系人',email:'acceptance@example.test',ownerId:login.user.id});
const models=await request('/models');const reasoning=models.find(m=>m.purpose==='reasoning');assert.ok(reasoning);
const evidence={kind:'meeting',title:'完整业务验收',body:'客户需要统一销售记录，预算尚待正式审批，本周希望收到方案。'};
let initial,failed;
try{
 await request(`/models/${reasoning.id}`,{enabled:false},'PATCH');
 initial=await request(`/customers/${customer.id}/evidence`,evidence);
 failed=await until(`/runs/${initial.runId}`,r=>r.status==='failed');
 assert.ok(failed.error);assert.equal(failed.actionId,null);
 await request(`/runs/${initial.runId}/retry`,{reason:'模型仍停用时不得重试'},'POST',409);
}finally{await request(`/models/${reasoning.id}`,{enabled:true},'PATCH');}
const retries=await Promise.all([1,2].map(()=>request(`/runs/${initial.runId}/retry`,{reason:'已重新启用规划模型，恢复任务'})));
assert.equal(retries[0].id,retries[1].id);assert.equal(retries[0].parentRunId,initial.runId);assert.equal(retries[0].attempt,2);
assert.equal((await request(`/runs/${initial.runId}`)).status,'failed');
const imported={runId:retries[0].id};
const planned=await until(`/runs/${imported.runId}`,r=>r.status==='waiting_approval');
let detail=await request(`/customers/${customer.id}`);
for(const fact of detail.facts)await request(`/facts/${fact.id}/review`,{expectedRevision:fact.revision,status:'confirmed',note:'已逐条核对本次会议原文'});
const conversation=await request('/conversations',{customerId:customer.id,title:'方案推进验收'});
const message={requestId:crypto.randomUUID(),message:'查看待审批的方案，下一步如何推进？'};
const turn=await request(`/conversations/${conversation.id}/messages`,message);
assert.equal((await request(`/conversations/${conversation.id}/messages`,message)).id,turn.id);
assert.ok(turn.reply.cards.some(card=>card.href.includes(`action=${planned.actionId}`)));
const action=detail.actions.find(a=>a.id===planned.actionId);assert.ok(action);
await request(`/actions/${action.id}/approve`,{expectedRevision:action.revision});
await until(`/runs/${imported.runId}`,r=>r.status==='completed');
detail=await request(`/customers/${customer.id}`);assert.ok(detail.actions.find(a=>a.id===action.id).receipt.simulated);
assert.equal((await request(`/conversations/${conversation.id}`)).turns.length,1);
assert.equal((await request(`/customers/${customer.id}/evidence`,evidence)).runId,imported.runId);
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format();
const period=today.slice(0,7);
const overviewPath=`/management/overview?period=${period}&ownerId=${login.user.id}`;
const before=await request(overviewPath);
const opportunity=await request('/opportunities',{title:'客户方案与采购推进',customerId:customer.id,ownerId:login.user.id,amountCents:100_000,expectedCloseDate:today,stage:'proposal',forecastCategory:'commit',nextStep:'核对方案需求',nextStepDueDate:today,evidenceId:initial.evidence.id,lostReason:null});
const fact=detail.facts.find(item=>item.status==='confirmed');assert.ok(fact);
const proposalInput={requestId:crypto.randomUUID(),expectedRevision:opportunity.revision,factId:fact.id,factRevision:fact.revision,goal:'确认客户预算审批与方案范围',dueDate:today};
const proposal=await request(`/opportunities/${opportunity.id}/advancements`,proposalInput);
assert.equal((await request(`/opportunities/${opportunity.id}/advancements`,proposalInput)).id,proposal.id);
assert.ok((await request('/work/inbox')).advancements.some(item=>item.id===proposal.id));
const decision={expectedRevision:proposal.revision,decision:'apply',note:'已核对原文，采用本次推进计划'};
const applied=await request(`/opportunities/${opportunity.id}/advancements/${proposal.id}/decision`,decision);
assert.equal(applied.status,'applied');
assert.equal((await request(`/opportunities/${opportunity.id}/advancements/${proposal.id}/decision`,decision)).id,applied.id);
assert.ok(!(await request('/work/inbox')).advancements.some(item=>item.id===proposal.id));
const advanced=await request(`/opportunities/${opportunity.id}`);
assert.equal(advanced.opportunity.nextStep,proposal.nextStep);assert.equal(advanced.opportunity.stage,'proposal');assert.equal(advanced.opportunity.amountCents,100_000);
const task=await request(`/opportunities/${opportunity.id}/tasks`,{title:'核对预算审批与方案范围',assigneeId:login.user.id,dueDate:today});
assert.ok((await request('/work/inbox')).tasks.some(item=>item.id===task.id));
await request(`/opportunity-tasks/${task.id}/complete`,{expectedRevision:task.revision,completionNote:'已完成核对，以合同登记结果为准'});
assert.ok(!(await request('/work/inbox')).tasks.some(item=>item.id===task.id));
const snapshot=await request('/management/snapshots',{period,ownerId:login.user.id});
assert.equal(snapshot.metrics.forecastCents,before.metrics.forecastCents+100_000);
const signed=await request(`/opportunities/${opportunity.id}/contract`,{expectedRevision:advanced.opportunity.revision,amountCents:120_000,signedDate:today,reference:`ACCEPT-CONTRACT-${crypto.randomUUID()}`,installments:[{amountCents:120_000,dueDate:today}]});
assert.equal(signed.opportunity.stage,'won');assert.equal(signed.receivables.length,1);
const paymentInput={amountCents:120_000,paidDate:today,reference:`ACCEPT-PAYMENT-${crypto.randomUUID()}`};
const payment=await request(`/receivables/${signed.receivables[0].id}/payments`,paymentInput);
assert.equal((await request(`/receivables/${signed.receivables[0].id}/payments`,paymentInput)).id,payment.id);
const after=await request(overviewPath);
assert.equal(after.metrics.bookedCents,before.metrics.bookedCents+120_000);assert.equal(after.metrics.collectedCents,before.metrics.collectedCents+120_000);
assert.equal(after.snapshotDeltaCents,20_000);
assert.equal((await request(`/opportunities/${opportunity.id}`)).receivables[0].remainingCents,0);
assert.deepEqual((await request(`/management/snapshots?period=${period}&ownerId=${login.user.id}`)).find(item=>item.id===snapshot.id),snapshot);
await request('/auth/logout',{});await request('/bootstrap',undefined,'GET',401);
console.log(JSON.stringify({result:'passed',customerId:customer.id,runId:imported.runId,conversationId:conversation.id,opportunityId:opportunity.id,checks:['password login','real customer creation','real Temporal failure','concurrent retry deduplication','immutable failed history','Temporal planning','fact verification','persistent idempotent conversation','authorized action navigation','approval','simulated receipt','duplicate import','grounded advancement','idempotent proposal and decision','inbox removal after decision','task completion','immutable forecast snapshot','contract registration','idempotent payment','receivable settlement','management result feedback','logout revocation']},null,2));
