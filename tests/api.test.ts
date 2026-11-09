import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createApi } from '../apps/api/src/index.js';
import { seed } from '../packages/database/src/seed.js';
import { migrate } from '../packages/database/src/migrate.js';

test('HTTP trust boundary: session identity, tenant scope, strict inputs and safe sources',{skip:!process.env.DATABASE_URL},async t=>{
 const previous={auth:process.env.INTENT_DEV_AUTH,mode:process.env.NODE_ENV};
 process.env.INTENT_DEV_AUTH='true';process.env.NODE_ENV='test';
 const {app,db}=await createApi();
 try {
  await migrate(db);await seed(db);await app.listen(0,'127.0.0.1');
  const base=await app.getUrl();
  const req=async(path:string,body?:unknown,token?:string,extra:Record<string,string>={})=>{
   const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:`Bearer ${token}`}:{ }),...extra},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};
  };
  assert.equal((await req('/customers')).status,401);
  assert.equal((await req('/dev/session',{tenantId:'tenant_isolation',role:'admin'})).status,400);
  assert.equal((await req('/dev/session',{},undefined,{origin:'https://untrusted.example'})).status,403);
  const hostileHostStatus=await new Promise<number>((resolve,reject)=>{const r=httpRequest(base+'/api/dev/session',{method:'POST',headers:{host:'untrusted.example','content-type':'application/json'}},response=>{response.resume();resolve(response.statusCode!);});r.on('error',reject);r.end('{}');});
  assert.equal(hostileHostStatus,403);
  const admin=await req('/dev/session',{});assert.equal(admin.status,201);assert.ok(admin.data.token);
  const customers=await req('/customers',undefined,admin.data.token);assert.equal(customers.status,200);assert.equal(customers.data.length,3);assert.ok(!customers.data.some((c:{id:string})=>c.id==='cus_isolation'));
  assert.equal((await req('/customers/cus_isolation',undefined,admin.data.token)).status,404);
  const sales=await req('/dev/session',{memberId:'usr_zhaoshan'});assert.equal(sales.status,201);
  assert.equal((await req('/members',{name:'Forge',email:'forge@example.com',role:'admin',active:true},sales.data.token)).status,403);
  assert.equal((await req('/customers/cus_qinghe',undefined,sales.data.token)).status,404);
  assert.equal((await req('/customers/cus_lanhai/evidence',{kind:'meeting',title:'Invalid',body:'valid length body',tenantId:'tenant_isolation'},admin.data.token)).status,400);
  const reply=await req('/chat',{customerId:'cus_lanhai',message:'下一步怎么推进？'},admin.data.token);assert.equal(reply.status,201);assert.equal(reply.data.model,'fixture-v1');const linked=await req('/opportunities?customerId=cus_lanhai',undefined,admin.data.token);assert.ok(reply.data.cards.every((c:{href:string})=>c.href.startsWith('/customers/cus_lanhai')||linked.data.some((o:{id:string})=>[ `/opportunities/${o.id}`, `/opportunities/${o.id}?tab=finance`, `/opportunities/${o.id}?focus=advance` ].includes(c.href))));
  const bootstrap=await req('/bootstrap',undefined,admin.data.token);assert.equal(bootstrap.data.execution.model,'fixture');assert.equal(bootstrap.data.execution.transport,'simulated');
 } finally {await app.close();await db.close();if(previous.auth===undefined)delete process.env.INTENT_DEV_AUTH;else process.env.INTENT_DEV_AUTH=previous.auth;if(previous.mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.mode;}
});

test('production refuses development authentication',async()=>{
 const prior=process.env.NODE_ENV,mode=process.env.INTENT_AUTH_MODE;process.env.NODE_ENV='production';process.env.INTENT_AUTH_MODE='development';
 try{await assert.rejects(createApi(),/[Pp]roduction|生产/);}finally{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior;if(mode===undefined)delete process.env.INTENT_AUTH_MODE;else process.env.INTENT_AUTH_MODE=mode;}
});

test('API signal shutdown drains in-flight HTTP before closing the database pool',{timeout:5000},async()=>{
 const keys=['DATABASE_URL','NODE_ENV','INTENT_AUTH_MODE','INTENT_PUBLIC_ORIGIN'] as const;
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 process.env.DATABASE_URL='postgresql://unused:unused@127.0.0.1:1/unused';
 process.env.NODE_ENV='test';process.env.INTENT_AUTH_MODE='password';process.env.INTENT_PUBLIC_ORIGIN='http://localhost:5173';
 const {app,db}=await createApi();
 const order:string[]=[];
 let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;});
 const allowed=new Promise<void>(resolve=>{release=resolve;});
 const closeDatabase=db.close.bind(db);
 let closed=false;
 db.close=async()=>{order.push('database');closed=true;await closeDatabase();};
 app.use('/shutdown-check',async(_req:unknown,res:{end(value:string):void})=>{enter();await allowed;order.push('response');res.end('completed');});
 try{
  await app.listen(0,'127.0.0.1');
  const response=fetch((await app.getUrl())+'/shutdown-check',{headers:{connection:'close'}});
  await entered;
  // NestApplicationContext.close accepts a signal; NestExpressApplication's
  // public interface omits this optional argument used by its shutdown hooks.
  const stopping=(app.close as (signal?:string)=>Promise<void>).call(app,'SIGTERM').then(()=>{order.push('stopped');});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,false,'pending HTTP work still owns its database access');
  release();
  assert.equal(await (await response).text(),'completed');
  await stopping;
  assert.deepEqual(order,['response','database','stopped']);
 }finally{
  release();await app.close();if(!closed)await closeDatabase();
  for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
 }
});
