import { updateMember } from './member-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { IdentityService } from '../packages/domain/src/identity.js';
import { IntentService, DomainError } from '../packages/domain/src/index.js';
import { AuthService, validateAuthConfiguration } from '../apps/api/src/auth.js';
import type { Actor } from '../packages/contracts/src/index.js';
import type { Request } from '../apps/api/src/tokens.js';

const status=(expected:number)=>(error:unknown)=>error instanceof DomainError&&error.status===expected;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const secret='test-only Random phrase 871!';
const replacement='replacement Test phrase 653!';
const authKeys=['INTENT_AUTH_MODE','INTENT_DEV_AUTH','NODE_ENV','INTENT_PUBLIC_ORIGIN'] as const;
function environment(){const prior=Object.fromEntries(authKeys.map(key=>[key,process.env[key]]));return ()=>{for(const key of authKeys){const value=prior[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}};}

test('identity configuration fails closed and password mode overrides development flags',()=>{
  const restore=environment();
  try {
    process.env.INTENT_AUTH_MODE='password';process.env.INTENT_DEV_AUTH='true';process.env.NODE_ENV='test';delete process.env.INTENT_PUBLIC_ORIGIN;
    assert.throws(validateAuthConfiguration,/INTENT_PUBLIC_ORIGIN/);
    process.env.INTENT_PUBLIC_ORIGIN='http://127.0.0.1:5173';assert.equal(validateAuthConfiguration().mode,'password');
    for(const origin of ['https://crm.example/path','https://crm.example/','https://user:pass@crm.example','null','https://crm.example?x=1']){process.env.INTENT_PUBLIC_ORIGIN=origin;assert.throws(validateAuthConfiguration);}
    process.env.NODE_ENV='production';process.env.INTENT_PUBLIC_ORIGIN='http://crm.example';assert.throws(validateAuthConfiguration,/HTTPS/);
    process.env.INTENT_PUBLIC_ORIGIN='https://crm.example';assert.equal(validateAuthConfiguration().cookieName,'__Host-intent_session');
    process.env.INTENT_AUTH_MODE='development';assert.throws(validateAuthConfiguration,/Production authentication/);
    process.env.NODE_ENV='test';delete process.env.INTENT_DEV_AUTH;assert.throws(validateAuthConfiguration);
    process.env.INTENT_DEV_AUTH='true';assert.equal(validateAuthConfiguration().mode,'development');
    process.env.INTENT_AUTH_MODE='unknown';assert.throws(validateAuthConfiguration);
  } finally {restore();}
});

test('persistent identity: credential hashing, revocation, tenancy, locking and browser boundary',{skip:!process.env.DATABASE_URL},async t=>{
  const db=createDatabase(process.env.DATABASE_URL!),identity=new IdentityService(db),suffix=randomUUID().replaceAll('-','');
  const workspaceId=`identity_${suffix}`,otherWorkspace=`identity_other_${suffix}`,email=`admin_${suffix}@example.com`;
  const client=`identity-client-${suffix}`,keys=new Set<string>(),cliWorkspace=`identity_cli_${suffix}`,tenants=[workspaceId,otherWorkspace,cliWorkspace];
  const login=async (password=secret,account=email,workspace=workspaceId,source=client)=>{
    keys.add(digest(`source:${source}`));keys.add(digest(`account:${workspace}:${account.toLowerCase()}`));
    return identity.login({workspaceId:workspace,email:account,password},source);
  };
  let admin:Actor,otherAdmin:Actor,memberId:string;
  try {
    await migrate(db);
    await t.test('initialization creates only a private workspace, salted credentials and fixture configuration',async()=>{
      const result=await identity.bootstrapWorkspace({workspaceId,workspaceName:'Private workspace',adminName:'Owner',email:email.toUpperCase(),password:secret});
      const other=await identity.bootstrapWorkspace({workspaceId:otherWorkspace,workspaceName:'Other private workspace',adminName:'Other owner',email,password:replacement});
      admin={tenantId:workspaceId,memberId:result.memberId,role:'admin'};otherAdmin={tenantId:otherWorkspace,memberId:other.memberId,role:'admin'};
      assert.equal((await db.query('SELECT email FROM members WHERE tenant_id=$1',[workspaceId])).rows[0]!.email,email);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM customers WHERE tenant_id=$1',[workspaceId])).rows[0]!.count,0);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM model_connections WHERE tenant_id=$1',[workspaceId])).rows[0]!.count,2);
      const credential=(await db.query('SELECT * FROM identity_credentials WHERE tenant_id=$1',[workspaceId])).rows[0]!;
      assert.match(credential.password_hash,/^scrypt\$131072\$8\$1\$/);assert.ok(!JSON.stringify(credential).includes(secret));
      await assert.rejects(identity.bootstrapWorkspace({workspaceId,workspaceName:'Replacement',adminName:'Other',email,password:replacement}),status(409));
      await assert.rejects(identity.bootstrapWorkspace({workspaceId:'unused',workspaceName:'Bad',adminName:'Bad',email,password:'short'}),status(400));
    });
    await t.test('sessions survive service reconstruction and persist only a hash for exactly eight hours',async()=>{
      const result=await login(secret,email.toUpperCase());assert.deepEqual(result.actor,{...admin,authorizationVersion:1});assert.equal(result.user.email,email);
      const session=(await db.query('SELECT * FROM identity_sessions WHERE token_hash=$1',[digest(result.token)])).rows[0]!;
      assert.equal(new Date(session.expires_at).getTime()-new Date(session.created_at).getTime(),8*3600*1000);
      assert.ok(!JSON.stringify(session).includes(result.token));assert.equal(result.token.length,43);
      assert.deepEqual(await new IdentityService(db).authenticate(result.token),result.actor);
      await identity.logout(result.token);await assert.rejects(identity.authenticate(result.token),status(401));
      await identity.logout(result.token); // Repeated logout is harmless.
      const expiring=await login();
      await db.query("UPDATE identity_sessions SET created_at=now()-interval '9 hours',expires_at=now()-interval '1 hour' WHERE token_hash=$1",[digest(expiring.token)]);
      await assert.rejects(identity.authenticate(expiring.token),status(401));
    });
    await t.test('wrong accounts, disabled accounts and passwords return the same failure; role changes are fresh',async()=>{
      const failures=[];
      for(const [password,account,workspace] of [['wrong password',email,workspaceId],[secret,`absent_${suffix}@example.com`,workspaceId],[secret,email,otherWorkspace]]){
        try{await login(password,account,workspace);}catch(error){assert.ok(error instanceof DomainError);failures.push([error.status,error.code,error.message]);}
      }
      assert.equal(failures.length,3);assert.deepEqual(failures[0],failures[1]);assert.deepEqual(failures[0],failures[2]);
      const session=await login();
      await db.query("UPDATE members SET role='manager' WHERE tenant_id=$1 AND id=$2",[workspaceId,admin.memberId]);
      assert.equal((await identity.authenticate(session.token)).role,'manager');
      await db.query('UPDATE members SET active=false WHERE tenant_id=$1 AND id=$2',[workspaceId,admin.memberId]);
      await assert.rejects(identity.authenticate(session.token),status(401));await assert.rejects(login(),status(401));
      await db.query("UPDATE members SET active=true,role='admin' WHERE tenant_id=$1 AND id=$2",[workspaceId,admin.memberId]);
    });
    await t.test('login rate limits persist after rejected transactions and across service instances',async()=>{
      const absent=`limited_${suffix}@example.com`,source=`limited-source-${suffix}`;
      for(let i=0;i<5;i++)await assert.rejects(login(secret,absent,workspaceId,source),status(401));
      await assert.rejects(new IdentityService(db).login({workspaceId,email:absent,password:secret},source),status(429));
      const row=(await db.query('SELECT attempts FROM identity_login_limits WHERE bucket_key=$1',[digest(`account:${workspaceId}:${absent}`)])).rows[0]!;assert.equal(row.attempts,6);
      // A different account cannot bypass a source bucket that has exhausted its budget.
      const ipKey=digest(`source:exhausted-${suffix}`);keys.add(ipKey);
      await db.query("INSERT INTO identity_login_limits(bucket_key,attempts,reset_at) VALUES($1,100,now()+interval '15 minutes')",[ipKey]);
      await assert.rejects(login(secret,email,workspaceId,`exhausted-${suffix}`),status(429));
      await db.query("UPDATE identity_login_limits SET reset_at=now()-interval '1 second' WHERE bucket_key=$1",[digest(`account:${workspaceId}:${absent}`)]);
      await assert.rejects(login(secret,absent,workspaceId,source),status(401));
    });
    await t.test('only the fresh tenant administrator can assign a password; reset revokes every session',async()=>{
      memberId=`member_${suffix}`;
      await db.query("INSERT INTO members(tenant_id,id,name,email,role) VALUES($1,$2,'Member',$3,'sales')",[workspaceId,memberId,`member_${suffix}@example.com`]);
      const forged:Actor={tenantId:workspaceId,memberId,role:'admin'};
      await assert.rejects(identity.setMemberPassword(forged,admin.memberId,{password:secret}),status(403));
      await assert.rejects(identity.setMemberPassword(admin,otherAdmin.memberId,{password:secret}),status(404));
      await identity.setMemberPassword(admin,memberId,{password:secret});
      const first=await login(secret,`member_${suffix}@example.com`),second=await login(secret,`member_${suffix}@example.com`);
      const hashBefore=(await db.query('SELECT password_hash FROM identity_credentials WHERE tenant_id=$1 AND member_id=$2',[workspaceId,memberId])).rows[0]!.password_hash;
      await identity.setMemberPassword(admin,memberId,{password:secret});
      assert.notEqual((await db.query('SELECT password_hash FROM identity_credentials WHERE tenant_id=$1 AND member_id=$2',[workspaceId,memberId])).rows[0]!.password_hash,hashBefore);
      await assert.rejects(identity.authenticate(first.token),status(401));await assert.rejects(identity.authenticate(second.token),status(401));
      await login(secret,`member_${suffix}@example.com`);
    });
    await t.test('deactivation revokes every session permanently across reactivation',async()=>{
      const intent=new IntentService(db),account=`member_${suffix}@example.com`;
      const first=await login(secret,account),second=await login(secret,account);
      const details={name:'Member',email:account,role:'sales' as const,active:true};
      await updateMember(intent,admin,memberId,{...details,active:false});
      try {
        await assert.rejects(identity.authenticate(first.token),status(401));
        await assert.rejects(login(secret,account),status(401));
      } finally { await updateMember(intent,admin,memberId,details); }
      await assert.rejects(identity.authenticate(first.token),status(401));
      await assert.rejects(identity.authenticate(second.token),status(401));
      const rows=(await db.query('SELECT revoked_at FROM identity_sessions WHERE token_hash=ANY($1::text[])',[[digest(first.token),digest(second.token)]])).rows;
      assert.equal(rows.length,2);assert.ok(rows.every(row=>row.revoked_at));
      assert.equal((await login(secret,account)).actor.memberId,memberId);
    });
    await t.test('changing a password verifies the old secret and revokes all sessions',async()=>{
      const first=await login(),second=await login();
      await assert.rejects(identity.changePassword(admin,{currentPassword:'not the secret',newPassword:replacement}),status(401));
      assert.deepEqual(await identity.authenticate(first.token),first.actor);
      await identity.changePassword(admin,{currentPassword:secret,newPassword:replacement});
      await assert.rejects(identity.authenticate(first.token),status(401));await assert.rejects(identity.authenticate(second.token),status(401));
      await assert.rejects(login(),status(401));await login(replacement);
      await identity.changePassword(admin,{currentPassword:replacement,newPassword:secret});
    });
    await t.test('an old-password login racing a reset cannot leave a valid old-password session',async()=>{
      const outcomes=await Promise.allSettled([login(),identity.changePassword(admin,{currentPassword:secret,newPassword:replacement})]);
      assert.equal(outcomes[1]!.status,'fulfilled');
      const pending=outcomes[0]!;
      if(pending.status==='fulfilled')await assert.rejects(identity.authenticate(pending.value!.token),status(401));
      else assert.ok(status(401)(pending.reason));
      await login(replacement);await identity.changePassword(admin,{currentPassword:replacement,newPassword:secret});
    });
    await t.test('password HTTP boundary uses cookies, exact Origin and no development or Bearer fallback',async()=>{
      const restore=environment();
      try {
        process.env.INTENT_AUTH_MODE='password';process.env.INTENT_DEV_AUTH='true';process.env.NODE_ENV='test';process.env.INTENT_PUBLIC_ORIGIN='http://127.0.0.1:5173';
        const auth=new AuthService(new IntentService(db),identity),headers=new Map<string,string>(),response={setHeader:(key:string,value:string)=>{headers.set(key,value);}};
        const request:Request={headers:{origin:process.env.INTENT_PUBLIC_ORIGIN},socket:{remoteAddress:client},method:'POST'};
        keys.add(digest(`source:${client}`));keys.add(digest(`account:${workspaceId}:${email}`));
        for(const origin of [undefined,'http://localhost:5173','http://127.0.0.1:5173.evil.example','null'])await assert.rejects(auth.login({...request,headers:{origin}},{workspaceId,email,password:secret},response),status(403));
        const result=await auth.login(request,{workspaceId,email,password:secret},response);
        assert.deepEqual(Object.keys(result),['user']);assert.equal(auth.mode().demo,false);
        const cookie=headers.get('Set-Cookie')!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Path=\//);assert.match(cookie,/Max-Age=28800/);assert.doesNotMatch(cookie,/Secure/);
        const cookieHeader=cookie.split(';')[0]!;
        assert.deepEqual(await auth.authenticate({...request,method:'GET',headers:{cookie:cookieHeader}}),await new IntentService(db).getActor(admin.memberId,workspaceId));
        await assert.rejects(auth.authenticate({...request,headers:{cookie:cookieHeader}}),status(403));
        await assert.rejects(auth.authenticate({...request,method:'GET',headers:{authorization:`Bearer ${cookieHeader.split('=')[1]}`}}),status(401));
        await assert.rejects(auth.issue({...request,socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:3100'}},{}),status(403));
        await auth.logout({...request,headers:{origin:process.env.INTENT_PUBLIC_ORIGIN,cookie:cookieHeader}},response);
        assert.match(headers.get('Set-Cookie')!,/Max-Age=0/);await assert.rejects(auth.authenticate({...request,method:'GET',headers:{cookie:cookieHeader}}),status(401));
        process.env.NODE_ENV='production';process.env.INTENT_PUBLIC_ORIGIN='https://crm.example';
        new AuthService(new IntentService(db),identity).setCookie(response,'a'.repeat(43));assert.match(headers.get('Set-Cookie')!,/^__Host-intent_session=/);assert.match(headers.get('Set-Cookie')!,/; Secure$/);
      } finally {restore();}
    });
    await t.test('audit records contain neither secrets nor credential hashes',async()=>{
      const audit=JSON.stringify((await db.query('SELECT * FROM audit_events WHERE tenant_id=$1',[workspaceId])).rows);
      assert.ok(!audit.includes(secret));assert.ok(!audit.includes(replacement));assert.ok(!audit.includes('scrypt$'));
      assert.ok(audit.includes('identity.password.changed'));assert.ok(audit.includes('identity.password.set'));
    });
    await t.test('bootstrap CLI accepts a secret over stdin, never prints it and cannot reset a workspace',async()=>{
      const run=()=>new Promise<{code:number|null;output:string}>((resolve,reject)=>{
        const env:NodeJS.ProcessEnv={...process.env,INTENT_BOOTSTRAP_WORKSPACE_ID:cliWorkspace,INTENT_BOOTSTRAP_WORKSPACE_NAME:'CLI private workspace',INTENT_BOOTSTRAP_ADMIN_NAME:'CLI owner',INTENT_BOOTSTRAP_EMAIL:email};
        delete env.INTENT_BOOTSTRAP_PASSWORD;
        const child=spawn(process.execPath,['--import','tsx','scripts/bootstrap-admin.ts','--password-stdin'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env,stdio:['pipe','pipe','pipe']});
        let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{output+=String(chunk);});child.on('error',reject);child.on('close',code=>resolve({code,output}));child.stdin.end(`${secret}\n`);
      });
      const first=await run();assert.equal(first.code,0,first.output);assert.ok(!first.output.includes(secret));
      const again=await run();assert.equal(again.code,1);assert.ok(!again.output.includes(secret));
      const result=await login(secret,email,cliWorkspace);assert.equal(result.actor.tenantId,cliWorkspace);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM customers WHERE tenant_id=$1',[cliWorkspace])).rows[0]!.count,0);
    });
  } finally {
    for(const table of ['identity_sessions','identity_credentials','audit_events','model_connections','members','tenants'])await db.query(`DELETE FROM ${table} WHERE ${table==='tenants'?'id':'tenant_id'}=ANY($1::text[])`,[tenants]);
    await db.query('DELETE FROM identity_login_limits WHERE bucket_key=ANY($1::text[])',[[...keys]]);await db.close();
  }
});
