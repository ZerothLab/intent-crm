import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApi} from '../apps/api/src/index.js';
import {migrate} from '../packages/database/src/migrate.js';
import {FixtureModel} from '../packages/harness/src/index.js';

test('password HTTP: encrypted model configuration, validation, cancellation and runtime administration',{skip:!process.env.DATABASE_URL},async()=>{
 const keys=['NODE_ENV','INTENT_AUTH_MODE','INTENT_PUBLIC_ORIGIN','INTENT_ENCRYPTION_KEY','INTENT_MODEL_ALLOWED_HOSTS'] as const;
 const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));Object.assign(process.env,{NODE_ENV:'test',INTENT_AUTH_MODE:'password',INTENT_PUBLIC_ORIGIN:'http://localhost:5173',INTENT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),INTENT_MODEL_ALLOWED_HOSTS:'models.example.test'});
 const server=await createApi();let cookie='';const workspaceId=`prod_http_${randomUUID().replaceAll('-','')}`;const password=randomUUID()+randomUUID();
 try{
  await migrate(server.db);await server.identity.bootstrapWorkspace({workspaceId,workspaceName:'Production HTTP acceptance',adminName:'Administrator',email:'owner@example.test',password});await server.app.listen(0,'127.0.0.1');const base=await server.app.getUrl();
  async function request(path:string,body?:unknown,method=body===undefined?'GET':'POST',origin='http://localhost:5173'){
   const response=await fetch(base+'/api'+path,{method,headers:{origin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,headers:response.headers,data:await response.json()};
  }
  assert.equal((await request('/models')).status,401);const login=await request('/auth/login',{workspaceId,email:'owner@example.test',password});cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const config={name:'DeepSeek',provider:'deepseek',model:'deepseek-flash',purpose:'reasoning',baseUrl:'https://api.deepseek.com',apiKey:'test-placeholder-provider-credential'};
  assert.equal((await request('/models',{...config,tenantId:'forged'})).status,400);
  assert.equal((await request('/models',config,'POST','https://hostile.test')).status,403);
  const saved=await request('/models',config);assert.equal(saved.status,201);assert.equal(saved.data.enabled,false);assert.ok(!JSON.stringify(saved).includes(config.apiKey));
  assert.equal((await request(`/models/${saved.data.id}`,{enabled:true,expectedRevision:1},'PATCH')).status,409);
  const custom=await request(`/models/${saved.data.id}/configuration`,{...config,provider:'openai-compatible',baseUrl:'https://models.example.test/v1',expectedRevision:1},'PATCH');assert.equal(custom.status,200);assert.equal(custom.data.revision,2);
  assert.equal((await request(`/models/${saved.data.id}/configuration`,{...config,expectedRevision:1},'PATCH')).status,409);
  assert.equal((await request('/models',{...config,provider:'openai-compatible',baseUrl:null})).status,400);
  const fixtures=(await request('/models')).data.filter((m:{provider:string})=>m.provider==='fixture');assert.equal((await request(`/models/${fixtures[0].id}/test`,{expectedRevision:fixtures[0].revision})).status,201);
  const customer=(await request('/customers',{name:'Acme',industry:'Services',contact:'Buyer',email:'buyer@example.test',ownerId:login.data.user.id})).data;
  const source=await request(`/customers/${customer.id}/evidence`,{title:'Source',body:'The customer needs a confirmed implementation schedule.',locale:'zh-CN'});assert.equal(source.status,201);
  const context=await server.service.getPlanningContext(workspaceId,source.data.runId);assert.equal(context.locale,'zh-CN');const action=await server.service.acceptPlan(workspaceId,source.data.runId,await new FixtureModel().plan(context));
  assert.equal((await request(`/actions/${action.id}/cancel`,{expectedRevision:action.revision,note:'Customer withdrew the request.'})).data.status,'cancelled');
  const after=(await request(`/customers/${customer.id}`)).data;assert.ok(after.commitments.every((c:{status:string})=>c.status==='cancelled'));assert.equal(after.actions[0].receipt,null);
  const runtime=await request('/settings/runtime');assert.equal(runtime.status,200);assert.ok(Array.isArray(runtime.data.stalledItems));
  const signed=await request(`/integrations/${workspaceId}/events`,{eventId:'untrusted',type:'delivery',operationId:'unknown',outcome:'delivered',reference:'forged'});assert.equal(signed.status,401);
 }finally{await server.app.close();await server.db.close();for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}}
});
