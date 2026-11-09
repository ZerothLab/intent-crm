import { updateMember } from './member-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { DomainError, IntentService } from '../packages/domain/src/index.js';
import type { Actor, Role } from '../packages/contracts/src/index.js';

const status=(expected:number)=>(error:unknown)=>error instanceof DomainError&&error.status===expected;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

test('workspace management persists names with tenant, role, revision and HTTP boundaries',{skip:!process.env.DATABASE_URL},async t=>{
 const keys=['NODE_ENV','INTENT_AUTH_MODE','INTENT_PUBLIC_ORIGIN'] as const;
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 process.env.NODE_ENV='test';process.env.INTENT_AUTH_MODE='password';process.env.INTENT_PUBLIC_ORIGIN='http://localhost:5173';
 const api=await createApi(),suffix=randomUUID().replaceAll('-','');
 const workspaceId=`workspace_${suffix}`,otherId=`workspace_other_${suffix}`,tenantIds=[workspaceId,otherId];
 const password=randomUUID()+randomUUID(),source=`workspace-test:${suffix}`;
 const loginBuckets=new Set([digest(`source:${source}`)]);
 let admin:Actor,other:Actor,sales:Actor;
 const actors:Actor[]=[];
 const audit=async()=> (await api.db.query("SELECT actor_id,entity_id,details FROM audit_events WHERE tenant_id=$1 AND event='workspace.updated' ORDER BY created_at,id",[workspaceId])).rows;
 try {
  await migrate(api.db);
  const owner=await api.identity.bootstrapWorkspace({workspaceId,workspaceName:'原团队',adminName:'Owner',email:'owner@example.test',password});
  const otherOwner=await api.identity.bootstrapWorkspace({workspaceId:otherId,workspaceName:'另一团队',adminName:'Other owner',email:'owner@example.test',password});
  admin={tenantId:workspaceId,memberId:owner.memberId,role:'admin'};
  other={tenantId:otherId,memberId:otherOwner.memberId,role:'admin'};
  for(const role of ['manager','sales','engineer'] as Role[]){
   const member=await api.service.createMember(admin,{name:role,email:`${role}@example.test`,role,active:true});
   actors.push({tenantId:workspaceId,memberId:member.id,role});
  }
  sales=actors.find(actor=>actor.role==='sales')!;
  await api.service.createMember(admin,{name:'Inactive',email:'inactive@example.test',role:'sales',active:false});

  await t.test('active members read only their workspace and member counts',async()=>{
   const workspace=await api.service.getWorkspace(admin);
   assert.deepEqual(workspace,{id:workspaceId,name:'原团队',revision:1,memberCount:5,activeMemberCount:4});
   for(const actor of actors)assert.deepEqual(await api.service.getWorkspace(actor),workspace);
   assert.deepEqual(await api.service.getWorkspace(other),{id:otherId,name:'另一团队',revision:1,memberCount:1,activeMemberCount:1});
   await assert.rejects(api.service.getWorkspace({...admin,tenantId:otherId}),status(401));
  });

  await t.test('fresh role authorization rejects forged roles and inactive members',async()=>{
   for(const actor of actors)await assert.rejects(api.service.updateWorkspace({...actor,role:'admin'},{name:'越权',expectedRevision:1}),status(403));
   await updateMember(api.service,admin,sales.memberId,{name:'sales',email:'sales@example.test',role:'sales',active:false});
   await assert.rejects(api.service.getWorkspace(sales),status(401));
   await assert.rejects(api.service.updateWorkspace({...sales,role:'admin'},{name:'越权',expectedRevision:1}),status(401));
   await updateMember(api.service,admin,sales.memberId,{name:'sales',email:'sales@example.test',role:'sales',active:true});
   assert.equal((await audit()).length,0);
  });

  await t.test('rename trims, persists, updates bootstrap and audits exact before/after',async()=>{
   const result=await api.service.updateWorkspace(admin,{name:'  星河团队  ',expectedRevision:1});
   assert.equal(result.name,'星河团队');assert.equal(result.revision,2);assert.equal(result.id,workspaceId);
   assert.deepEqual(await new IntentService(api.db).getWorkspace(admin),result);
   assert.equal((await api.service.bootstrap(admin)).workspace.name,'星河团队');
   assert.equal((await api.service.getWorkspace(other)).name,'另一团队');
   assert.deepEqual(await audit(),[{actor_id:admin.memberId,entity_id:workspaceId,details:{before:{name:'原团队',revision:1},after:{name:'星河团队',revision:2}}}]);
   assert.deepEqual(await api.service.updateWorkspace(admin,{name:'星河团队',expectedRevision:2}),result);
   assert.equal((await audit()).length,1,'same-name saves do not add revisions or audit noise');
   await assert.rejects(api.service.updateWorkspace(admin,{name:'星河团队',expectedRevision:1}),status(409));
  });

  await t.test('concurrent editors cannot silently overwrite each other',async()=>{
   const results=await Promise.allSettled(['并发甲','并发乙'].map(name=>api.service.updateWorkspace(admin,{name,expectedRevision:2})));
   const successes=results.filter(result=>result.status==='fulfilled');
   const failures=results.filter(result=>result.status==='rejected');
   assert.equal(successes.length,1);assert.equal(failures.length,1);
   assert.ok(status(409)(failures[0]!.reason));
   const workspace=await api.service.getWorkspace(admin);
   assert.equal(workspace.revision,3);assert.equal(workspace.name,successes[0]!.value.name);
   assert.equal((await audit()).length,2);
  });

  await t.test('invalid names, versions and tenant fields have no write side effects',async()=>{
   const before=await api.service.getWorkspace(admin);
   for(const input of [
    {name:' ',expectedRevision:3},{name:'x'.repeat(161),expectedRevision:3},
    {name:'Invalid',expectedRevision:0},{name:'Invalid',expectedRevision:1.5},
    {name:'Invalid',expectedRevision:3,tenantId:otherId},{name:'Invalid',expectedRevision:3,id:otherId}
   ])await assert.rejects(api.service.updateWorkspace(admin,input),status(400));
   assert.deepEqual(await api.service.getWorkspace(admin),before);assert.equal((await audit()).length,2);
  });

  await t.test('HTTP uses cookie identity, strict inputs, CSRF and persisted sessions',async()=>{
   await api.identity.setMemberPassword(admin,sales.memberId,{password});
   const cookie=async(workspace:string,email:string)=>{
    loginBuckets.add(digest(`account:${workspace}:${email}`));
    const session=await api.identity.login({workspaceId:workspace,email,password},source);
    return `intent_session=${session.token}`;
   };
   const adminCookie=await cookie(workspaceId,'owner@example.test'),salesCookie=await cookie(workspaceId,'sales@example.test'),otherCookie=await cookie(otherId,'owner@example.test');
   await api.app.listen(0,'127.0.0.1');const base=await api.app.getUrl();
   const request=async(path:string,body?:unknown,session=adminCookie,extra:Record<string,string>={},method=body===undefined?'GET':'PATCH')=>{
    const response=await fetch(base+'/api'+path,{method,headers:{...(session?{cookie:session}:{}),origin:'http://localhost:5173',...(body===undefined?{}:{'content-type':'application/json'}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
   };
   assert.equal((await request('/workspace',undefined,'')).status,401);
   assert.equal((await request('/workspace',undefined,salesCookie)).data.id,workspaceId);
   assert.equal((await request('/workspace',undefined,otherCookie)).data.id,otherId);
   assert.equal((await request(`/workspace?tenantId=${otherId}`)).status,400);
   assert.equal((await request(`/workspace?tenantId=${otherId}`,{name:'越权',expectedRevision:3})).status,400);
   assert.equal((await request('/workspace',{name:'越权',expectedRevision:3,tenantId:otherId})).status,400);
   assert.equal((await request('/workspace',{name:'越权',expectedRevision:3},salesCookie)).status,403);
   assert.equal((await request('/workspace',{name:'无来源',expectedRevision:3},adminCookie,{origin:''})).status,403);
   assert.equal((await request('/workspace',{},adminCookie,{},'POST')).status,404,'there is no public workspace provisioning route');
   const update=await request('/workspace',{name:'HTTP 保存的团队',expectedRevision:3},adminCookie,{'x-tenant-id':otherId});
   assert.equal(update.status,200);assert.equal(update.data.id,workspaceId);assert.equal(update.data.revision,4);
   assert.equal((await request('/workspace',{name:'旧版本',expectedRevision:3})).status,409);
   assert.equal((await request('/bootstrap')).data.workspace.name,'HTTP 保存的团队');
   assert.equal((await request('/workspace',undefined,otherCookie)).data.name,'另一团队');
   assert.equal((await audit()).length,3);

   const secondAdmin=await api.service.createMember(admin,{name:'Second admin',email:'second@example.test',role:'admin',active:true});
   await updateMember(api.service,{...admin,memberId:secondAdmin.id},admin.memberId,{name:'Owner',email:'owner@example.test',role:'manager',active:true});
   await assert.rejects(api.service.updateWorkspace(admin,{name:'旧管理员身份',expectedRevision:4}),status(403));
   assert.equal((await request('/workspace',{name:'旧管理员会话',expectedRevision:4})).status,401);
   assert.equal((await request('/workspace')).status,401);
  });
 } finally {
  await api.app.close();
  try {
   for(const table of ['identity_sessions','identity_credentials','audit_events','model_connections','members','tenants'])await api.db.query(`DELETE FROM ${table} WHERE ${table==='tenants'?'id':'tenant_id'}=ANY($1::text[])`,[tenantIds]);
   await api.db.query('DELETE FROM identity_login_limits WHERE bucket_key=ANY($1::text[])',[[...loginBuckets]]);
  } finally {
   await api.db.close();
   for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  }
 }
});
