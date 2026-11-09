import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDatabase } from '../packages/database/src/index.js';
import { migrate } from '../packages/database/src/migrate.js';
import { IdentityService } from '../packages/domain/src/identity.js';

async function secret(prompt:string):Promise<string>{
  if(!stdin.isTTY)throw new Error('Noninteractive initialization requires INTENT_BOOTSTRAP_PASSWORD or --password-stdin.');
  stdout.write(prompt);stdin.setRawMode(true);stdin.resume();
  return new Promise<string>((resolve,reject)=>{
    let value='';
    const finish=(error?:Error)=>{stdin.off('data',receive);stdin.setRawMode(false);stdin.pause();stdout.write('\n');if(error)reject(error);else resolve(value);};
    const receive=(data:Buffer)=>{
      for(const character of data.toString('utf8')){
        if(character==='\u0003'){finish(new Error('Initialization cancelled.'));return;}
        if(character==='\r'||character==='\n'){finish();return;}
        if(character==='\u007f'||character==='\b')value=Array.from(value).slice(0,-1).join('');
        else if(character>=' ')value+=character;
      }
    };
    stdin.on('data',receive);
  });
}

export async function bootstrapAdmin(){
  const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL is required.');
  const values={workspaceId:process.env.INTENT_BOOTSTRAP_WORKSPACE_ID,workspaceName:process.env.INTENT_BOOTSTRAP_WORKSPACE_NAME,adminName:process.env.INTENT_BOOTSTRAP_ADMIN_NAME,email:process.env.INTENT_BOOTSTRAP_EMAIL};
  if(Object.values(values).some(value=>!value)){
    if(!stdin.isTTY)throw new Error('Set INTENT_BOOTSTRAP_WORKSPACE_ID, INTENT_BOOTSTRAP_WORKSPACE_NAME, INTENT_BOOTSTRAP_ADMIN_NAME and INTENT_BOOTSTRAP_EMAIL.');
    const reader=createInterface({input:stdin,output:stdout});
    try {for(const key of Object.keys(values) as (keyof typeof values)[])if(!values[key])values[key]=(await reader.question(`${key}: `)).trim();}
    finally{reader.close();}
  }
  let password=process.env.INTENT_BOOTSTRAP_PASSWORD;
  if(process.argv.includes('--password-stdin')){
    if(stdin.isTTY)throw new Error('--password-stdin requires a noninteractive input stream.');
    let content='';for await(const chunk of stdin){content+=String(chunk);if(content.length>1024)throw new Error('Password input is too long.');}
    password=content.replace(/\r?\n$/,'');
  }
  if(!password){password=await secret('Password (hidden, 12–128 characters): ');if(password!==await secret('Confirm password: '))throw new Error('Passwords do not match.');}
  const db=createDatabase(url);
  try {
    await migrate(db);
    const result=await new IdentityService(db).bootstrapWorkspace({workspaceId:values.workspaceId!,workspaceName:values.workspaceName!,adminName:values.adminName!,email:values.email!,password});
    console.info(`Workspace ${result.tenantId} initialized. Administrator ${result.memberId} can sign in with the configured email. No business demo data was inserted.`);
  } finally{await db.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))bootstrapAdmin().catch(error=>{console.error(error instanceof Error?error.message:'Initialization failed.');process.exitCode=1;});
