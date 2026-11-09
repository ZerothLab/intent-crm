import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { productionConfigurationErrors } from './production-config.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
if(existsSync(`${root}/.env`))process.loadEnvFile(`${root}/.env`);
const errors=productionConfigurationErrors(process.env);
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
if(!existsSync(`${root}/apps/web/dist/index.html`)){console.error('Run pnpm build before pnpm start.');process.exit(1);}
// The server and workflow bundler run the same checked TypeScript sources used by tests.
// Keep the locked runtime dependencies installed; do not use install --prod.
const env={...process.env,NODE_ENV:'production',INTENT_AUTH_MODE:'password',INTENT_DEV_AUTH:'false',INTENT_SERVE_WEB:'true'};
const grouped=process.platform!=='win32';
const children=['apps/api/src/index.ts','apps/worker/src/index.ts'].map(file=>spawn(process.execPath,['--import','tsx',file],{cwd:root,env,stdio:'inherit',detached:grouped}));
let stopping=false;
function stop(code=0){
  if(stopping)return;stopping=true;process.exitCode=code;
  const signal=(child,value)=>{try{if(grouped&&child.pid)process.kill(-child.pid,value);else child.kill(value);}catch(error){if(error.code!=='ESRCH')console.error(error.message);}};
  children.forEach(child=>signal(child,'SIGTERM'));
  setTimeout(()=>{children.forEach(child=>signal(child,'SIGKILL'));process.exit(code);},25000).unref();
}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
children.forEach(child=>{child.on('exit',code=>{if(!stopping)stop(code===0||code===null?1:code);});child.on('error',error=>{console.error(error.message);stop(1);});});
