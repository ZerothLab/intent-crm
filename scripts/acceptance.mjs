import assert from 'node:assert/strict';
const base=process.env.INTENT_API_URL||'http://127.0.0.1:3100/api';
const timeout=Number(process.env.INTENT_ACCEPTANCE_TIMEOUT_MS||45000);
let token;
async function request(path,{method='GET',body,status=200,authenticated=true}={}){
 const response=await fetch(base+path,{method,headers:{...(authenticated&&token?{authorization:`Bearer ${token}`}:{ }),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(data)}`);return data;
}
async function until(path,condition){const started=Date.now();while(Date.now()-started<timeout){const value=await request(path);if(condition(value))return value;if(value.status==='failed')throw new Error(value.error||'Workflow failed');await new Promise(r=>setTimeout(r,300));}throw new Error(`Timed out waiting for ${path}; verify Temporal and worker are running.`);}
await request('/customers',{status:401,authenticated:false});
const session=await request('/dev/session',{method:'POST',body:{},status:201,authenticated:false});token=session.token;
await request('/customers/cus_isolation',{status:404});
const before=await request('/customers/cus_lanhai');
const evidenceInput={kind:'meeting',title:`系统验收 · 会议跟进 ${crypto.randomUUID()}`,body:`${before.customer.contact}：我们需要先评估 20 席方案，预算尚未最终审批。李明：请先整理方案草稿，未经确认不要发出。`};
const imported=await request('/customers/cus_lanhai/evidence',{method:'POST',status:201,body:evidenceInput});
const duplicate=await request('/customers/cus_lanhai/evidence',{method:'POST',status:201,body:evidenceInput});
assert.equal(duplicate.evidence.id,imported.evidence.id);assert.equal(duplicate.runId,imported.runId);
const planned=await until(`/runs/${imported.runId}`,r=>r.status==='waiting_approval');assert.ok(planned.actionId);
let detail=await request('/customers/cus_lanhai');let action=detail.actions.find(a=>a.id===planned.actionId);assert.ok(action);assert.equal(action.status,'draft');assert.equal(action.receipt,null);
assert.equal(detail.evidence.length,before.evidence.length+1);
assert.ok(detail.facts.every(f=>detail.evidence.some(e=>e.id===f.evidenceId&&e.body.includes(f.quote))));
const revised=await request(`/actions/${action.id}`,{method:'PATCH',body:{expectedRevision:action.revision,recipient:action.recipient,subject:action.subject,body:action.body+'\n\n验收补充：以正式报价和合同为准。'}});
assert.equal(revised.revision,action.revision+1);
await request(`/actions/${action.id}/approve`,{method:'POST',status:409,body:{expectedRevision:action.revision}});
await request(`/actions/${action.id}/approve`,{method:'POST',status:201,body:{expectedRevision:revised.revision}});
await until(`/runs/${imported.runId}`,r=>r.status==='completed');
detail=await request('/customers/cus_lanhai');action=detail.actions.find(a=>a.id===action.id);assert.equal(action.status,'succeeded');assert.ok(action.receipt?.simulated);assert.equal(action.receipt.operationId,action.operationId);
assert.ok(detail.commitments.some(c=>c.actionId===action.id&&c.status==='fulfilled'&&c.completionReceiptId===action.receipt.id));
assert.equal(detail.customer.stage,'awaiting_review');
await request(`/actions/${action.id}/approve`,{method:'POST',status:409,body:{expectedRevision:action.revision}});
const chat=await request('/chat',{method:'POST',status:201,body:{customerId:'cus_lanhai',message:'下一步怎么推进？'}});
assert.equal(chat.model,'fixture-v1');
const opportunities=await request('/opportunities?customerId=cus_lanhai');
const customerPath='/customers/cus_lanhai';
const destinations=new Set([customerPath,...['fields','facts','runs'].map(focus=>`${customerPath}?focus=${focus}`),...detail.actions.map(a=>`${customerPath}?action=${a.id}`),...opportunities.flatMap(o=>[`/opportunities/${o.id}`,`/opportunities/${o.id}?tab=finance`,`/opportunities/${o.id}?tab=tasks`,`/opportunities/${o.id}?focus=advance`])]);
assert.ok(chat.cards.every(c=>destinations.has(c.href)));
assert.ok(chat.cards.some(c=>c.href.endsWith('?focus=advance')),'next-step questions must reach a proposal review panel');
const after=await request('/customers/cus_lanhai');assert.equal(after.actions.find(a=>a.id===action.id).receipt.id,action.receipt.id);
console.log(JSON.stringify({result:'passed',checks:['authentication','tenant isolation','persistent evidence','duplicate import','Temporal planning','grounded candidates','revision invalidation','approval','receipt','commitment proof','duplicate guard','structured AI navigation'],runId:imported.runId,actionId:action.id,receiptId:action.receipt.id},null,2));
