import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { modelConfigInput, modelConfigUpdateInput, type Actor, type ModelConnection } from '@intent/contracts';
import type { Connection, Database } from '@intent/database';
import { DomainError } from './index.js';
import { currentActor } from './authorization.js';

function encryptionKey(): Buffer {
  const encoded = process.env.INTENT_ENCRYPTION_KEY ?? '';
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new DomainError('ENCRYPTION_UNAVAILABLE', 503, 'The deployment administrator must configure a 32-byte encryption key before credentials can be saved.');
  return key;
}
export function encryptSecret(value: string, scope: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(scope));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext].map(b => b.toString('base64')).join('.');
}
export function decryptSecret(value: string, scope: string): string {
  try {
    const [nonce, tag, ciphertext] = value.split('.').map(s => Buffer.from(s, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce!);
    cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(tag!);
    return Buffer.concat([cipher.update(ciphertext!), cipher.final()]).toString('utf8');
  } catch { throw new DomainError('CREDENTIAL_UNAVAILABLE', 503, 'The configured credential cannot be unlocked. Contact your deployment administrator.'); }
}
export function validateEndpoint(value: string, kind: 'MODEL'|'DELIVERY'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new DomainError('ENDPOINT_NOT_ALLOWED', 400, 'Enter a valid HTTPS endpoint URL.'); }
  const allowed = new Set([...(kind === 'MODEL' ? ['api.deepseek.com'] : []), ...(process.env[`INTENT_${kind}_ALLOWED_HOSTS`] ?? '').split(',').map(v => v.trim()).filter(Boolean)]);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !allowed.has(url.hostname)) {
    throw new DomainError('ENDPOINT_NOT_ALLOWED', 400, `Use an HTTPS endpoint whose hostname is approved in INTENT_${kind}_ALLOWED_HOSTS.`);
  }
  return url.href.replace(/\/+$/, '');
}
export function publicModel(row: Record<string, any>): ModelConnection {
  return { id:row.id, name:row.name, provider:row.provider, model:row.model, enabled:row.enabled, purpose:row.purpose, baseUrl:row.base_url,
    hasApiKey:!!row.credential, revision:row.revision, timeoutMs:row.timeout_ms, testedRevision:row.tested_revision,
    testedAt:row.tested_at?.toISOString() ?? null, testError:row.test_error ?? null };
}
export async function selectedModel(tx: Connection, tenantId: string, purpose: ModelConnection['purpose'] = 'reasoning'): Promise<ModelConnection> {
  const row = (await tx.query('SELECT * FROM model_connections WHERE tenant_id=$1 AND purpose=$2 AND enabled=true ORDER BY id LIMIT 1 FOR SHARE', [tenantId, purpose])).rows[0];
  if (!row) throw new DomainError('MODEL_DISABLED', 409, `No enabled ${purpose} model is configured.`);
  return publicModel(row);
}
export type RuntimeModel = { connection:ModelConnection; apiKey?:string };
export class ModelSettingsService {
  constructor(private readonly db: Database) {}
  private async authorize(tx:Connection, actor:Actor, admin=true) {
    const row=await currentActor(tx,actor);
    if(admin&&row.role!=='admin') throw new DomainError('FORBIDDEN',403,'Workspace administrator permission is required.');
  }
  async save(actor:Actor, input:z.input<typeof modelConfigInput>|z.input<typeof modelConfigUpdateInput>, id?:string):Promise<ModelConnection> {
    const data=id?modelConfigUpdateInput.parse(input):modelConfigInput.parse(input);
    return this.db.transaction(async tx=>{
      await this.authorize(tx,actor);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`models:${actor.tenantId}`]);
      const modelId=id??`model_${randomUUID().replaceAll('-','')}`;
      const before=id?(await tx.query('SELECT * FROM model_connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,id])).rows[0]:null;
      if(id&&!before) throw new DomainError('NOT_FOUND',404,'Model connection not found.');
      if(before&&before.revision!==('expectedRevision' in data?data.expectedRevision:0)) throw new DomainError('CONFLICT',409,'Model settings changed. Reload before saving.');
      const baseUrl=data.provider==='fixture'?null:validateEndpoint(data.provider==='deepseek'?'https://api.deepseek.com':data.baseUrl??'', 'MODEL');
      if(data.provider==='fixture'&&data.model!=='fixture-v1') throw new DomainError('VALIDATION',400,'The demo provider supports fixture-v1 only.');
      const credential=data.provider==='fixture'?null:data.apiKey?encryptSecret(data.apiKey,`${actor.tenantId}:${modelId}`):before?.provider===data.provider&&before?.base_url===baseUrl?before.credential:null;
      if(data.provider!=='fixture'&&!credential) throw new DomainError('CREDENTIAL_REQUIRED',400,'Enter a credential for this provider and endpoint.');
      const row=(await tx.query(`INSERT INTO model_connections(tenant_id,id,name,provider,model,purpose,base_url,credential,timeout_ms,enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false) ON CONFLICT(tenant_id,id) DO UPDATE SET
        name=excluded.name,provider=excluded.provider,model=excluded.model,purpose=excluded.purpose,base_url=excluded.base_url,credential=excluded.credential,
        timeout_ms=excluded.timeout_ms,revision=model_connections.revision+1,enabled=false,tested_revision=NULL,tested_at=NULL,test_error=NULL RETURNING *`,
        [actor.tenantId,modelId,data.name,data.provider,data.model,data.purpose,baseUrl,credential,data.timeoutMs])).rows[0]!;
      await tx.query('INSERT INTO audit_events(tenant_id,id,actor_id,event,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[actor.tenantId,randomUUID(),actor.memberId,'model.configured',modelId,JSON.stringify({revision:row.revision,provider:data.provider,purpose:data.purpose})]);
      return publicModel(row);
    });
  }
  async runtime(tenantId:string, id:string, expectedRevision?:number):Promise<RuntimeModel> {
    const row=(await this.db.query('SELECT * FROM model_connections WHERE tenant_id=$1 AND id=$2',[tenantId,id])).rows[0];
    if(!row||expectedRevision!==undefined&&row.revision!==expectedRevision) throw new DomainError('CONFLICT',409,'Model configuration changed. Try again.');
    if(row.provider!=='fixture') validateEndpoint(row.base_url, 'MODEL');
    return {connection:publicModel(row),...(row.credential?{apiKey:decryptSecret(row.credential,`${tenantId}:${id}`)}:{})};
  }
  async forActor(actor:Actor, purpose:ModelConnection['purpose']='reasoning'):Promise<RuntimeModel> {
    const connection=await this.db.transaction(async tx=>{await this.authorize(tx,actor,false);return selectedModel(tx,actor.tenantId,purpose);});
    return this.runtime(actor.tenantId,connection.id,connection.revision);
  }
  async forTest(actor:Actor,id:string,revision:number):Promise<RuntimeModel> {
    await this.db.transaction(tx=>this.authorize(tx,actor));
    return this.runtime(actor.tenantId,id,revision);
  }
  async recordTest(actor:Actor,id:string,revision:number,error:string|null):Promise<ModelConnection> {
    return this.db.transaction(async tx=>{
      await this.authorize(tx,actor);
      const row=(await tx.query('UPDATE model_connections SET tested_at=now(),tested_revision=$3,test_error=$4 WHERE tenant_id=$1 AND id=$2 AND revision=$3 RETURNING *',[actor.tenantId,id,revision,error])).rows[0];
      if(!row)throw new DomainError('CONFLICT',409,'Model configuration changed during the connection test.');
      return publicModel(row);
    });
  }
}
