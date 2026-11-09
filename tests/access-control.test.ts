import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { DomainError, ModelSettingsService, DeliveryService } from '../packages/domain/src/index.js';
import { FixtureModel } from '../packages/harness/src/index.js';
import type { Actor, Member, Role } from '../packages/contracts/src/index.js';

const status = (expected:number) => (error:unknown) => error instanceof DomainError && error.status === expected;
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format();

test('access control closes HTTP roles, revocation, stale approvals, audit and concurrent handover', {skip:!process.env.DATABASE_URL}, async t => {
    const keys = ['NODE_ENV','INTENT_AUTH_MODE','INTENT_PUBLIC_ORIGIN'] as const;
    const before = Object.fromEntries(keys.map(key => [key,process.env[key]]));
    Object.assign(process.env,{NODE_ENV:'test',INTENT_AUTH_MODE:'password',INTENT_PUBLIC_ORIGIN:'http://localhost:5173'});
    const server = await createApi(), {service:intent,product,commercial,identity,db} = server;
    const tenantId = `access_${randomUUID().replaceAll('-','')}`, foreignId = `foreign_${randomUUID().replaceAll('-','')}`;
    const password = randomUUID()+randomUUID(), cookies = new Map<string,string>();
    const actors = {} as Record<Role,Actor>, members = {} as Record<Role,Member>;
    let base = '';
    async function request(role:Role|null,path:string,body?:unknown,method=body===undefined?'GET':'POST',headers:Record<string,string>={}) {
        const response = await fetch(base+'/api'+path,{method,headers:{origin:'http://localhost:5173',...(role?{cookie:cookies.get(role)??''}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
        return {status:response.status,data:await response.json(),headers:response.headers};
    }
    async function login(role:Role) {
        const response = await request(null,'/auth/login',{workspaceId:tenantId,email:members[role].email,password});
        assert.equal(response.status,201); cookies.set(role,response.headers.get('set-cookie')!.split(';')[0]!);
    }
    const createCustomer = (ownerId:string) => product.createCustomer(actors.admin,{name:'Authorization customer',industry:'Services',contact:'Buyer',email:'buyer@example.test',ownerId});
    async function createPlan(ownerId=members.sales.id) {
        const customer = await createCustomer(ownerId);
        const source = await intent.addEvidence(actors.admin,customer.id,{title:'Customer requirements',body:'The customer needs a documented implementation plan and a confirmed budget.'});
        const action = await intent.acceptPlan(tenantId,source.runId,await new FixtureModel().plan(await intent.getPlanningContext(tenantId,source.runId)));
        return {customer,source,action};
    }
    const opportunityInput = (customerId:string,ownerId:string) => ({customerId,ownerId,title:'Implementation opportunity',amountCents:10000,expectedCloseDate:today(),stage:'proposal' as const,forecastCategory:'pipeline' as const,nextStep:'Confirm requirements',nextStepDueDate:today(),evidenceId:null,lostReason:null});
    async function changeMember(id:string,change:Partial<Pick<Member,'role'|'active'|'email'|'name'>>) {
        const member = (await intent.listMembers(actors.admin)).find(member => member.id === id)!;
        return intent.updateMember(actors.admin,id,{name:member.name,email:member.email,role:member.role,active:member.active,...change,expectedRevision:member.revision});
    }
    try {
        await migrate(db);
        const root = await identity.bootstrapWorkspace({workspaceId:tenantId,workspaceName:'Access control acceptance',adminName:'Owner',email:'admin@example.test',password});
        actors.admin = {tenantId,memberId:root.memberId,role:'admin'};
        members.admin = (await intent.listMembers(actors.admin))[0]!;
        for (const role of ['manager','sales','engineer'] as const) {
            members[role] = await intent.createMember(actors.admin,{name:role,email:`${role}@example.test`,role,active:true});
            actors[role] = {tenantId,memberId:members[role].id,role};
            await identity.setMemberPassword(actors.admin,members[role].id,{password});
        }
        await server.app.listen(0,'127.0.0.1'); base = await server.app.getUrl();
        for (const role of ['admin','manager','sales','engineer'] as const) await login(role);
        const {customer,source,action} = await createPlan();
        const opportunity = await commercial.createOpportunity(actors.sales,opportunityInput(customer.id,members.sales.id));
        const task = await commercial.createTask(actors.manager,opportunity.id,{title:'Check implementation requirements',assigneeId:members.sales.id,dueDate:today()});
        const models = await intent.listModels(actors.admin), model = models.find(model => model.purpose==='reasoning')!;
        const field = await intent.createField(actors.admin,{key:'review',label:'Review',type:'text',required:false,enabled:true,options:[]});

        await t.test('administrator commands reject managers, sales and engineers, including forged headers',async()=>{
            const config = {name:'Demo',provider:'fixture',model:'fixture-v1',purpose:'reasoning',baseUrl:null};
            const commands:[string,unknown?,string?][] = [
                ['/workspace',{name:'Unauthorized',expectedRevision:1},'PATCH'],
                ['/members',{name:'Intruder',email:'intruder@example.test',role:'admin',active:true}],
                [`/members/${members.sales.id}`,{name:'Sales',email:members.sales.email,role:'admin',active:true,expectedRevision:members.sales.revision},'PATCH'],
                [`/members/${members.sales.id}/credentials`,{password}],
                ['/models',config],[`/models/${model.id}/configuration`,{...config,expectedRevision:model.revision},'PATCH'],
                [`/models/${model.id}`,{enabled:false,expectedRevision:model.revision},'PATCH'],[`/models/${model.id}/test`,{expectedRevision:model.revision}],
                ['/fields',{key:'forged',label:'Forged',type:'text',required:false,enabled:true,options:[]}],
                [`/fields/${field.id}`,{key:'review',label:'Forged',type:'text',required:false,enabled:true,options:[]},'PATCH'],
                ['/settings/delivery'],['/settings/delivery',{expectedRevision:0,mode:'simulated',endpoint:null,sender:null},'PATCH'],
                ['/settings/runtime'],['/settings/runtime/recover',{runId:source.runId,note:'Unauthorized recovery'}],['/settings/audit'],
            ];
            for (const role of ['manager','sales','engineer'] as const) for (const [path,body,method] of commands)
                assert.equal((await request(role,path,body,method,{'x-role':'admin','x-tenant-id':foreignId})).status,403,`${role} ${method??'GET/POST'} ${path}`);
        });

        await t.test('management commands reject sales and engineers even for visible records',async()=>{
            const correction = {requestId:randomUUID(),note:'Unauthorized correction',evidenceId:source.evidence.id};
            const commands:[string,unknown?,string?][] = [
                [`/management/overview?period=${today().slice(0,7)}`],[`/management/snapshots?period=${today().slice(0,7)}`],
                ['/management/targets',{period:today().slice(0,7),ownerId:null,bookingsTargetCents:100,collectionTargetCents:100,expectedRevision:0}],
                ['/management/snapshots',{period:today().slice(0,7),ownerId:null}],
                [`/customers/${customer.id}/handover`,{expectedRevision:1,ownerId:members.manager.id,note:'Unauthorized handover'}],
                [`/actions/${action.id}/takeover`,{expectedRevision:1,note:'Unauthorized takeover'}],
                [`/actions/${action.id}/reconcile`,{expectedRevision:1,outcome:'delivered',reference:'Unauthorized confirmation'}],
                [`/opportunities/${opportunity.id}/contract`,{expectedRevision:1,amountCents:10000,signedDate:today(),reference:'unauthorized-contract',installments:[{amountCents:10000,dueDate:today()}]}],
                ['/receivables/missing/payments',{amountCents:100,paidDate:today(),reference:'unauthorized-payment'}],
                ['/payments/missing/refunds',{...correction,amountCents:100,refundedDate:today(),reference:'unauthorized-refund'}],
                ['/contracts/missing/cancel',correction],['/payments/missing/reverse',correction],['/refunds/missing/reverse',correction],
                [`/opportunities/${opportunity.id}/tasks`,{title:'Unauthorized task',assigneeId:members.sales.id,dueDate:today()}],
                [`/opportunity-tasks/${task.id}`,{expectedRevision:1,assigneeId:members.sales.id,dueDate:today(),status:'cancelled',note:'Unauthorized task edit'},'PATCH'],
            ];
            for (const role of ['sales','engineer'] as const) for (const [path,body,method] of commands)
                assert.equal((await request(role,path,body,method)).status,403,`${role} ${path}`);
        });

        await t.test('engineers can add evidence and complete assigned work but cannot perform sales commands',async()=>{
            const own = await createPlan(members.engineer.id);
            const deal = await commercial.createOpportunity(actors.admin,opportunityInput(own.customer.id,members.admin.id));
            const assigned = await commercial.createTask(actors.manager,deal.id,{title:'Engineering assessment',assigneeId:members.engineer.id,dueDate:today()});
            const fact = (await intent.getCustomer(actors.engineer,own.customer.id)).facts[0]!;
            const commands:[string,unknown,string?][] = [
                ['/customers',{name:'Forbidden customer',industry:'Services',contact:'Buyer',email:'buyer@example.test',ownerId:members.engineer.id}],
                [`/customers/${own.customer.id}`,{name:own.customer.name,industry:own.customer.industry,contact:own.customer.contact,email:own.customer.email,ownerId:members.engineer.id,expectedRevision:1,note:'Forbidden edit'},'PATCH'],
                [`/customers/${own.customer.id}/fields`,{expectedRevision:1,values:{review:'forged'}},'PATCH'],
                [`/facts/${fact.id}/review`,{expectedRevision:fact.revision,status:'confirmed',note:'Forbidden verification'}],
                [`/actions/${own.action.id}`,{expectedRevision:1,recipient:own.customer.email,subject:'Forbidden',body:'Forbidden update'},'PATCH'],
                [`/actions/${own.action.id}/approve`,{expectedRevision:1}],[`/actions/${own.action.id}/cancel`,{expectedRevision:1,note:'Forbidden cancellation'}],
                [`/runs/${own.source.runId}/retry`,{reason:'Forbidden planning retry'}],
                ['/opportunities',opportunityInput(own.customer.id,members.engineer.id)],
                [`/opportunities/${deal.id}`,{...opportunityInput(own.customer.id,members.admin.id),expectedRevision:1,note:'Forbidden edit'},'PATCH'],
                [`/opportunities/${deal.id}/advancements`,{requestId:randomUUID(),expectedRevision:1,factId:fact.id,factRevision:fact.revision,goal:'confirm_requirements',dueDate:today()}],
                [`/opportunities/${deal.id}/advancements/missing/decision`,{expectedRevision:1,decision:'apply',note:'Forbidden decision'}],
            ];
            for (const [path,body,method] of commands) assert.equal((await request('engineer',path,body,method)).status,403,path);
            assert.equal((await request('engineer',`/customers/${own.customer.id}/evidence`,{title:'Engineering evidence',body:'The reviewed integration requires a customer-provided test environment.'})).status,201);
            assert.equal((await request('engineer',`/opportunity-tasks/${assigned.id}/complete`,{expectedRevision:1,completionNote:'Technical assessment recorded.'})).status,201);
        });

        await t.test('other customer IDs and private conversations do not widen access',async()=>{
            const other = await identity.bootstrapWorkspace({workspaceId:foreignId,workspaceName:'Foreign workspace',adminName:'Foreign owner',email:'foreign@example.test',password});
            const foreign:Actor = {tenantId:foreignId,memberId:other.memberId,role:'admin'};
            const foreignCustomer = await product.createCustomer(foreign,{name:'Private foreign customer',industry:'Private',contact:'Private',email:'private@example.test',ownerId:foreign.memberId});
            const conversation = await product.createConversation(actors.sales,{customerId:customer.id,title:'Private sales discussion'});
            for (const role of ['admin','manager','sales','engineer'] as const) assert.equal((await request(role,`/customers/${foreignCustomer.id}`)).status,404);
            for (const role of ['admin','manager','engineer'] as const) assert.equal((await request(role,`/conversations/${conversation.id}`)).status,404);
            for (const path of [`/customers/${customer.id}`,`/customers/${customer.id}/runs`,`/runs/${source.runId}`,`/opportunities/${opportunity.id}`,`/opportunities/${opportunity.id}/advancements`])
                assert.equal((await request('engineer',path)).status,404,path);
            const listing = await request('sales','/customers',undefined,'GET',{'x-tenant-id':foreignId,'x-role':'admin'});
            assert.ok(listing.data.every((row:{ownerId:string}) => row.ownerId===members.sales.id));
            assert.equal((await request('sales','/customers',{name:'Forged tenant',industry:'Services',contact:'Buyer',email:'buyer@example.test',ownerId:members.sales.id,tenantId:foreignId})).status,400);
        });

        await t.test('member edits require exact revision and concurrent administrators cannot overwrite permissions',async()=>{
            const target = await intent.createMember(actors.admin,{name:'Revision member',email:'revision@example.test',role:'sales',active:true});
            const input = {name:target.name,email:target.email,role:target.role,active:target.active,expectedRevision:target.revision};
            assert.equal((await request('admin',`/members/${target.id}`,{...input,expectedRevision:undefined},'PATCH')).status,400);
            const results = await Promise.all([request('admin',`/members/${target.id}`,{...input,role:'manager'},'PATCH'),request('admin',`/members/${target.id}`,{...input,active:false},'PATCH')]);
            assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
            const saved = (await intent.listMembers(actors.admin)).find(member=>member.id===target.id)!;
            assert.equal(saved.revision,2);
            assert.equal((await request('admin',`/members/${members.admin.id}`,{name:members.admin.name,email:members.admin.email,role:'sales',active:true,expectedRevision:members.admin.revision},'PATCH')).status,409);
        });

        await t.test('role and email changes revoke sessions, in-flight authority and old approvals permanently',async()=>{
            const planned = await createPlan();
            await intent.approveAction(actors.sales,planned.action.id,{expectedRevision:1});
            const old = await identity.authenticate(cookies.get('sales')!.split('=')[1]!);
            await changeMember(members.sales.id,{role:'engineer'});
            assert.equal((await request('sales','/customers')).status,401);
            await changeMember(members.sales.id,{role:'sales'});
            await assert.rejects(intent.getCustomer(old,planned.customer.id),status(401));
            await assert.rejects(product.createConversation(old,{customerId:planned.customer.id,title:'Late answer'}),status(401));
            await assert.rejects(commercial.getOpportunity(old,opportunity.id),status(401));
            await assert.rejects(new ModelSettingsService(db).forActor(old),status(401));
            await assert.rejects(new DeliveryService(db).get({...old,role:'admin'}),status(401));
            assert.equal(await intent.executeAction(tenantId,planned.source.runId,1),'waiting_approval');
            assert.equal((await intent.getActionForRun(tenantId,planned.source.runId))!.receipt,null);
            await login('sales');
            members.sales = await changeMember(members.sales.id,{email:'renamed-sales@example.test'});
            assert.equal((await request('sales','/customers')).status,401);
            await login('sales');
            assert.equal((await request('sales','/customers')).status,200);
        });

        await t.test('disable and re-enable cannot resurrect an approval even when the approver remains active',async()=>{
            const owned = await createCustomer(members.sales.id);
            const source = await intent.addEvidence(actors.sales,owned.id,{title:'Initiated by sales',body:'The customer needs a reviewed delivery plan before proceeding.'});
            const action = await intent.acceptPlan(tenantId,source.runId,await new FixtureModel().plan(await intent.getPlanningContext(tenantId,source.runId)));
            await intent.approveAction(actors.admin,action.id,{expectedRevision:1});
            await changeMember(members.sales.id,{active:false}); await changeMember(members.sales.id,{active:true});
            assert.equal(await intent.executeAction(tenantId,source.runId,1),'waiting_approval');
            const draft = (await intent.getActionForRun(tenantId,source.runId))!;
            await intent.approveAction(actors.admin,action.id,{expectedRevision:draft.revision});
            assert.equal(await intent.executeAction(tenantId,source.runId,draft.revision),'succeeded');
            await login('sales');
        });

        await t.test('normal customer editing cannot bypass handover, including when no opportunities exist',async()=>{
            const owned = await createPlan();
            await intent.approveAction(actors.admin,owned.action.id,{expectedRevision:1});
            const {customer:record} = owned;
            await assert.rejects(product.updateCustomer(actors.admin,record.id,{name:record.name,industry:record.industry,contact:record.contact,email:record.email,ownerId:members.manager.id,expectedRevision:record.revision,note:'Bypass complete handover'}),status(409));
            await product.handoverCustomer(actors.manager,record.id,{ownerId:members.manager.id,expectedRevision:record.revision,note:'Transfer pending work together'});
            assert.equal(await intent.executeAction(tenantId,owned.source.runId,1),'waiting_approval');
            assert.equal((await request('sales',`/customers/${record.id}`)).status,404);
        });

        await t.test('handover cannot deadlock task completion or allow a former assignee to complete transferred work',async()=>{
            const owned = await createCustomer(members.sales.id);
            const deal = await commercial.createOpportunity(actors.sales,opportunityInput(owned.id,members.sales.id));
            const task = await commercial.createTask(actors.manager,deal.id,{title:'Concurrent handover task',assigneeId:members.sales.id,dueDate:today()});
            const blocker = await db.pool.connect();
            let completion:Promise<unknown>|undefined, handover:Promise<unknown>|undefined;
            try {
                await blocker.query('BEGIN');
                const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
                await blocker.query('SELECT id FROM opportunity_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,task.id]);
                handover = product.handoverCustomer(actors.manager,owned.id,{ownerId:members.manager.id,expectedRevision:1,note:'Concurrent responsibility transfer'});
                let waiting = false;
                for (let i=0;i<100;i++) { if ((await db.query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[pid])).rowCount) {waiting=true;break;} await delay(10); }
                assert.ok(waiting);
                completion = commercial.completeTask(actors.sales,task.id,{expectedRevision:1,completionNote:'Old owner completion'});
                const rejected = assert.rejects(completion,status(404));
                await blocker.query('COMMIT'); await handover; await rejected;
                const transferred = (await commercial.getOpportunity(actors.manager,deal.id)).tasks.find(row=>row.id===task.id)!;
                assert.equal(transferred.status,'open'); assert.equal(transferred.assigneeId,members.manager.id);
            } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.allSettled([completion,handover]); }
        });

        await t.test('audit is tenant-scoped, paginated and exposes no secrets or private business prose',async()=>{
            const page = await intent.listAudit(actors.admin,{category:'access'});
            assert.ok(page.items.some(row=>row.accessChange?.sessionsRevoked));
            const foreign = (await db.query('SELECT id FROM audit_events WHERE tenant_id=$1 LIMIT 1',[foreignId])).rows[0]!;
            assert.equal((await request('admin',`/settings/audit?cursor=${foreign.id}`)).status,404);
            assert.equal((await request('admin','/settings/audit?tenantId=forged')).status,400);
            await db.query("INSERT INTO audit_events(tenant_id,id,actor_id,event,entity_id,details) SELECT $1,'pagination_'||i,$2,'member.updated','audit-test',jsonb_build_object('password','secret-must-not-leak','body','private business prose') FROM generate_series(1,55) i",[tenantId,members.admin.id]);
            const first = await intent.listAudit(actors.admin,{category:'access'});
            assert.equal(first.items.length,50); assert.ok(first.nextCursor);
            const next = await intent.listAudit(actors.admin,{category:'access',cursor:first.nextCursor!});
            assert.ok(next.items.length); assert.ok(!next.items.some(row=>first.items.some(old=>old.id===row.id)));
            const serialized = JSON.stringify([first,next]);
            for (const value of ['secret-must-not-leak','private business prose',password,'scrypt$']) assert.ok(!serialized.includes(value));
        });
    } finally {
        await server.app.close(); await db.close();
        for (const key of keys) { if (before[key]===undefined) delete process.env[key]; else process.env[key]=before[key]; }
    }
});
