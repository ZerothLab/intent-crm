import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { deliveryConfigInput, type DeliverySettings, type Actor, type IntentAction } from '@intent/contracts';
import type { Database, Connection } from '@intent/database';
import { DomainError } from './index.js';
import { currentActor } from './authorization.js';
import { decryptSecret, encryptSecret, validateEndpoint } from './model-settings.js';

export type DeliveryEnvelope = { action:IntentAction; endpoint:string; sender:string; apiKey:string };
export type DeliveryResult = { outcome:'delivered'|'unknown'; reference?:string };
const publicSettings=(row?:Record<string,any>):DeliverySettings=>row?{revision:row.revision,mode:row.mode,endpoint:row.endpoint,sender:row.sender,hasApiKey:!!row.credential,hasWebhookSecret:!!row.webhook_secret}:{revision:0,mode:'simulated',endpoint:null,sender:null,hasApiKey:false,hasWebhookSecret:false};
export class DeliveryService {
  constructor(private readonly db:Database){}
  private async authorize(tx:Connection,actor:Actor){
    const row=await currentActor(tx,actor);
    if(row.role!=='admin')throw new DomainError('FORBIDDEN',403,'Workspace administrator permission is required.');
  }
  async get(actor:Actor):Promise<DeliverySettings>{return this.db.transaction(async tx=>{await this.authorize(tx,actor);return publicSettings((await tx.query('SELECT * FROM delivery_settings WHERE tenant_id=$1',[actor.tenantId])).rows[0]);});}
  async save(actor:Actor,input:z.input<typeof deliveryConfigInput>):Promise<DeliverySettings>{
    const data=deliveryConfigInput.parse(input);return this.db.transaction(async tx=>{
      await this.authorize(tx,actor);await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`delivery:${actor.tenantId}`]);
      const old=(await tx.query('SELECT * FROM delivery_settings WHERE tenant_id=$1 FOR UPDATE',[actor.tenantId])).rows[0];
      if((old?.revision??0)!==data.expectedRevision)throw new DomainError('CONFLICT',409,'Delivery settings changed. Reload before saving.');
      const endpoint=data.mode==='webhook'?validateEndpoint(data.endpoint??'','DELIVERY'):null;
      const credential=data.apiKey?encryptSecret(data.apiKey,`${actor.tenantId}:delivery`):old?.endpoint===endpoint?old.credential:null;
      const secret=data.webhookSecret?encryptSecret(data.webhookSecret,`${actor.tenantId}:webhook`):old?.webhook_secret;
      if(data.mode==='webhook'&&(!credential||!secret||!data.sender))throw new DomainError('VALIDATION',400,'A sender, gateway credential and webhook signing secret are required.');
      const row=(await tx.query(`INSERT INTO delivery_settings(tenant_id,revision,mode,endpoint,sender,credential,webhook_secret) VALUES($1,1,$2,$3,$4,$5,$6)
        ON CONFLICT(tenant_id) DO UPDATE SET revision=delivery_settings.revision+1,mode=excluded.mode,endpoint=excluded.endpoint,sender=excluded.sender,credential=excluded.credential,webhook_secret=excluded.webhook_secret RETURNING *`,
        [actor.tenantId,data.mode,endpoint,data.sender,credential,secret??null])).rows[0]!;
      await tx.query('INSERT INTO audit_events(tenant_id,id,actor_id,event,entity_id,details) VALUES($1,$2,$3,$4,$1,$5)',[actor.tenantId,randomUUID(),actor.memberId,'delivery.configured',JSON.stringify({mode:data.mode,revision:row.revision})]);
      return publicSettings(row);
    });
  }
  async verify(tenantId:string,body:Buffer,timestamp:string,signature:string):Promise<void>{
    const row=(await this.db.query('SELECT webhook_secret FROM delivery_settings WHERE tenant_id=$1',[tenantId])).rows[0];
    if(!row?.webhook_secret||!/^\d{10}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300||!/^\w{64}$/.test(signature))throw new DomainError('UNAUTHENTICATED',401,'Invalid integration signature.');
    const secret=decryptSecret(row.webhook_secret,`${tenantId}:webhook`);
    const expected=createHmac('sha256',secret).update(timestamp).update('.').update(body).digest();
    const received=Buffer.from(signature,'hex');
    if(received.length!==expected.length||!timingSafeEqual(expected,received))throw new DomainError('UNAUTHENTICATED',401,'Invalid integration signature.');
  }
}
