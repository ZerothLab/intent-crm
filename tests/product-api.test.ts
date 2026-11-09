import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApi} from '../apps/api/src/index.js';
import {migrate} from '../packages/database/src/migrate.js';
import {FixtureModel} from '../packages/harness/src/index.js';

test('password HTTP: empty workspace → customer → verified facts → private persistent conversation',{skip:!process.env.DATABASE_URL},async()=>{
 const keys=['NODE_ENV','INTENT_AUTH_MODE','INTENT_PUBLIC_ORIGIN','INTENT_DEV_AUTH'] as const;
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.NODE_ENV='test';process.env.INTENT_AUTH_MODE='password';process.env.INTENT_PUBLIC_ORIGIN='http://localhost:5173';process.env.INTENT_DEV_AUTH='true';
 let api=await createApi();const workspaceId=`http_${randomUUID().replaceAll('-','')}`;const password=randomUUID()+randomUUID();let cookie='';
 try{
  await migrate(api.db);
  await api.identity.bootstrapWorkspace({workspaceId,workspaceName:'空白团队',adminName:'验收管理员',email:'owner@example.test',password});
  await api.app.listen(0,'127.0.0.1');let base=await api.app.getUrl();
  const request=async(path:string,body?:unknown,method=body===undefined?'GET':'POST',origin:string|undefined='http://localhost:5173')=>{
   const response=await fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...(origin?{origin}:{})},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:response.status,headers:response.headers,data:await response.json()};
  };
  assert.deepEqual((await request('/auth/mode')).data,{mode:'password',demo:false,passwordMinLength:12});
  assert.equal((await request('/dev/session',{})).status,403);
  assert.equal((await request('/auth/login',{workspaceId,email:'owner@example.test',password},'POST','https://hostile.test')).status,403);
  const login=await request('/auth/login',{workspaceId,email:'owner@example.test',password});assert.equal(login.status,201);assert.ok(!login.data.token);
  cookie=login.headers.get('set-cookie')!.split(';')[0]!;assert.match(login.headers.get('set-cookie')!,/HttpOnly; SameSite=Strict/);
  const bootstrap=await request('/bootstrap');assert.equal(bootstrap.data.workspace.name,'空白团队');assert.deepEqual((await request('/customers')).data,[]);
  const input={name:'青屿科技',industry:'软件服务',contact:'林女士',email:'lin@example.test',ownerId:bootstrap.data.user.id};
  assert.equal((await request('/customers',{...input,tenantId:'forged'})).status,400);
  assert.equal((await request('/customers',input,'POST','')).status,403);
  const customer=await request('/customers',input);assert.equal(customer.status,201);const customerId=customer.data.id;
  const edited=await request(`/customers/${customerId}`,{...input,contact:'林总',expectedRevision:customer.data.revision,note:'已确认联系人称谓'},'PATCH');assert.equal(edited.status,200);
  assert.equal((await request(`/customers/${customerId}`,{...input,expectedRevision:customer.data.revision,note:'旧版本不可覆盖'},'PATCH')).status,409);
  const evidence=await request(`/customers/${customerId}/evidence`,{kind:'meeting',title:'需求访谈',body:'客户需要统一销售记录，预算为年度专项，具体金额尚未确认。'});assert.equal(evidence.status,201);
  const context=await api.service.getPlanningContext(workspaceId,evidence.data.runId);await api.service.acceptPlan(workspaceId,evidence.data.runId,await new FixtureModel().plan(context));
  const detail=await request(`/customers/${customerId}`);const fact=detail.data.facts[0];
  assert.equal((await request(`/facts/${fact.id}/review`,{expectedRevision:fact.revision,status:'confirmed',note:'已与联系人逐项核实'})).status,201);
  assert.equal((await request(`/facts/${fact.id}/reviews`)).data.length,1);
  const conversation=await request('/conversations',{customerId,title:'推进方案'});assert.equal(conversation.status,201);
  const message={requestId:randomUUID(),message:'哪些信息需要核实？'};
  const first=await request(`/conversations/${conversation.data.id}/messages`,message);assert.equal(first.status,201);assert.ok(first.data.reply.cards.some((c:{href:string})=>c.href.endsWith('?focus=facts')));
  assert.equal((await request(`/conversations/${conversation.data.id}/messages`,message)).data.id,first.data.id);
  assert.equal((await request(`/conversations/${conversation.data.id}/messages`,{...message,message:'不同消息不可重用编号'})).status,409);
  assert.equal((await request('/work/inbox')).data.actions.length,1);
  const opportunity=await request('/opportunities',{title:'知行试点推进',customerId,ownerId:bootstrap.data.user.id,amountCents:100000,expectedCloseDate:'2099-12-31',stage:'discovery',forecastCategory:'pipeline',nextStep:'原计划',nextStepDueDate:null,evidenceId:null,lostReason:null});assert.equal(opportunity.status,201);
  const proposalInput={requestId:randomUUID(),expectedRevision:1,factId:fact.id,factRevision:fact.revision+1,goal:'确认试点范围与预算边界',dueDate:'2099-12-31'};
  const proposalPath=`/opportunities/${opportunity.data.id}/advancements`;
  assert.equal((await request(proposalPath,{...proposalInput,tenantId:'forged'})).status,400);
  assert.equal((await request(proposalPath,{...proposalInput,nextStep:'模型直接提交经营字段'})).status,400);
  assert.equal((await request(proposalPath,proposalInput,'POST','')).status,403);
  const proposal=await request(proposalPath,proposalInput);assert.equal(proposal.status,201);assert.equal(proposal.data.status,'pending');
  assert.equal((await request(proposalPath,proposalInput)).data.id,proposal.data.id);
  assert.equal((await request(proposalPath+'?tenantId=forged')).status,400);
  assert.equal((await request(`/opportunities/${opportunity.data.id}`)).data.opportunity.nextStep,'原计划');
  assert.equal((await request('/work/inbox')).data.advancements[0].id,proposal.data.id);
  const nextStepReply=await request(`/conversations/${conversation.data.id}/messages`,{requestId:randomUUID(),message:'下一步怎么推进？'});
  assert.equal(nextStepReply.status,201);assert.ok(nextStepReply.data.reply.cards.some((c:{href:string})=>c.href===`/opportunities/${opportunity.data.id}?focus=advance`));
  const decision={expectedRevision:1,decision:'apply',note:'已核实来源与计划，确认采用'};
  assert.equal((await request(`${proposalPath}/${proposal.data.id}/decision`,{...decision,stage:'won'})).status,400);
  const applied=await request(`${proposalPath}/${proposal.data.id}/decision`,decision);assert.equal(applied.status,201);assert.equal(applied.data.status,'applied');
  assert.deepEqual((await request(`${proposalPath}/${proposal.data.id}/decision`,decision)).data,applied.data);
  const advanced=await request(`/opportunities/${opportunity.data.id}`);assert.equal(advanced.data.opportunity.nextStep,proposal.data.nextStep);assert.equal(advanced.data.opportunity.stage,'discovery');assert.equal(advanced.data.history.length,2);
  assert.equal((await request('/work/inbox')).data.advancements.length,0);
  assert.equal((await request('/conversations?unexpected=true')).status,400);
  await api.app.close();await api.db.close();api=await createApi();await api.app.listen(0,'127.0.0.1');base=await api.app.getUrl();
  assert.equal((await request(`/conversations/${conversation.data.id}`)).data.turns[0].id,first.data.id);
  assert.deepEqual((await request(proposalPath)).data,[applied.data]);
  assert.equal((await request('/auth/logout',{})).status,201);assert.equal((await request('/bootstrap')).status,401);
 }finally{
  await api.app.close();
  // Unique workspace data is retained in the isolated test database for failed-case inspection.
  await api.db.close();for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
 }
});
