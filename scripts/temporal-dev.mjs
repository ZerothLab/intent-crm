import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const { TestWorkflowEnvironment } = require('@temporalio/testing');
await mkdir(new URL('../.local/',import.meta.url),{recursive:true});
const env = await TestWorkflowEnvironment.createLocal({server:{...(process.env.TEMPORAL_CLI_PATH?{executable:{type:'existing-path',path:process.env.TEMPORAL_CLI_PATH}}:{}),ip:'127.0.0.1',port:7233,ui:true,uiPort:8233,dbFilename:new URL('../.local/temporal.db',import.meta.url).pathname,log:{format:'pretty',level:'error'}}});
console.log(`Temporal development server ready: ${env.address}; UI http://127.0.0.1:8233`);
let closing=false;
const keepAlive=setInterval(()=>{},60000);
async function stop(){if(closing)return;closing=true;clearInterval(keepAlive);await env.teardown();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
