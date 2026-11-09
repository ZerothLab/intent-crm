import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDatabase, type Database } from './index.js';
import { seedCommercial } from './seed-commercial.js';
export async function seed(db: Database) {
 await db.transaction(async tx => {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('intent_seed'))");
  await tx.query("INSERT INTO tenants(id,name) VALUES ('tenant_demo','Intent 演示工作区'),('tenant_isolation','隔离验证工作区') ON CONFLICT DO NOTHING");
  for (const m of [ ['tenant_demo','usr_liming','李明','liming@example.com','admin'],['tenant_demo','usr_zhaoshan','赵山','zhaoshan@example.com','sales'],['tenant_demo','usr_wangchen','王晨','wangchen@example.com','engineer'],['tenant_isolation','usr_other','隔离管理员','other@example.com','admin'] ]) {
   await tx.query('INSERT INTO members(tenant_id,id,name,email,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',m);
  }
  for (const c of [ ['tenant_demo','cus_lanhai','蓝海制造','先进制造','陈静','chenjing@example.com','usr_zhaoshan'],['tenant_demo','cus_yuanchuan','远川科技','企业服务','周远','zhouyuan@example.com','usr_liming'],['tenant_demo','cus_qinghe','青禾能源','清洁能源','许禾','xuhe@example.com','usr_wangchen'],['tenant_isolation','cus_isolation','隔离客户','验证','独立联系人','isolation@example.com','usr_other'] ]) {
   await tx.query('INSERT INTO customers(tenant_id,id,name,industry,contact,email,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',c);
  }
  await tx.query(`INSERT INTO field_definitions(tenant_id,id,key,label,type,required,enabled,options) VALUES
   ('tenant_demo','fld_budget','budget','预算（万元）','number',false,true,'[]'),
   ('tenant_demo','fld_timeline','timeline','预期采购时间','date',false,true,'[]'),
   ('tenant_demo','fld_priority','priority','跟进优先级','select',false,true,'["高","中","低"]') ON CONFLICT DO NOTHING`);
  await tx.query(`INSERT INTO model_connections(tenant_id,id,name,provider,model,purpose) VALUES
   ('tenant_demo','model_reasoning','Fixture reasoning (deterministic demo)','fixture','fixture-v1','reasoning'),
   ('tenant_demo','model_extraction','Fixture extraction (deterministic demo)','fixture','fixture-v1','extraction'),
   ('tenant_isolation','model_reasoning','Fixture isolated reasoning','fixture','fixture-v1','reasoning'),
   ('tenant_isolation','model_extraction','Fixture isolated extraction','fixture','fixture-v1','extraction') ON CONFLICT DO NOTHING`);
  await seedCommercial(tx);
 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const url=process.env.DATABASE_URL; if(!url) throw new Error('DATABASE_URL is required');
 const db=createDatabase(url); try { await seed(db); console.info('Deterministic demo seed applied without overwriting existing data.'); } finally { await db.close(); }
}
