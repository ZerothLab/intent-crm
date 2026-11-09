import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
if(existsSync(`${root}/.env`))process.loadEnvFile(`${root}/.env`);
const env={...process.env,NODE_ENV:process.env.NODE_ENV||'development'};
if(!env.DATABASE_URL){console.error('DATABASE_URL is required. Copy .env.example to .env and start PostgreSQL first.');process.exit(1);}
const pnpm=process.env.npm_execpath;
const commands=[['@intent/api','dev'],['@intent/worker','dev'],['@intent/web','dev']];
const grouped=process.platform!=='win32';
const children=commands.map(([pkg,task])=>pnpm?spawn(process.execPath,[pnpm,'--filter',pkg,task],{cwd:root,env,stdio:'inherit',detached:grouped}):spawn('pnpm',['--filter',pkg,task],{cwd:root,env,stdio:'inherit',detached:grouped}));
let stopping=false;
function signal(child,value){try{if(grouped&&child.pid)process.kill(-child.pid,value);else child.kill(value);}catch(error){if(error.code!=='ESRCH')console.error(error.message);}}
function stop(code=0){
 if(stopping)return;
 stopping=true;process.exitCode=code;
 for(const child of children)signal(child,'SIGTERM');
 // Stop the complete watcher/process tree, while allowing the worker to drain activities.
 const forced=setTimeout(()=>{for(const child of children)signal(child,'SIGKILL');process.exit(code);},25000);
 forced.unref();
}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
children.forEach(c=>c.on('exit',code=>{if(!stopping)stop(code??1)}));
children.forEach(c=>c.on('error',error=>{console.error(error.message);stop(1);}));
