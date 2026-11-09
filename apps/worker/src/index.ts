import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { WORKFLOW_QUEUE } from '@intent/contracts';
import { createDatabase } from '@intent/database';
import { IntentService } from '@intent/domain';
import { createActivities } from './activities.js';
import { OutboxDispatcher } from './dispatcher.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const database = createDatabase(url);
  const controller = new AbortController();
  let nativeConnection: NativeConnection | undefined;
  let clientConnection: Connection | undefined;
  try {
    nativeConnection = await NativeConnection.connect({ address });
    clientConnection = await Connection.connect({ address });
    const client = new Client({ connection: clientConnection, namespace });
    const service = new IntentService(database);
    const worker = await Worker.create({
      connection: nativeConnection,
      namespace,
      taskQueue: WORKFLOW_QUEUE,
      workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
      activities: createActivities(service),
      maxConcurrentActivityTaskExecutions: 4,
      shutdownGraceTime: '20 seconds',
    });
    const stop = () => {
      controller.abort();
      if (worker.getState() === 'RUNNING') worker.shutdown();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.info('Intent Temporal worker ready; workspace model and delivery settings are active.');
    const heartbeatId=`worker_${randomUUID()}`;
    const heartbeat=async()=>{while(!controller.signal.aborted){try{
      await clientConnection!.withAbortSignal(controller.signal,()=>clientConnection!.withDeadline(Date.now()+10000,()=>client.workflowService.getSystemInfo({})));
      if(!controller.signal.aborted&&worker.getState()==='RUNNING')await service.heartbeat(heartbeatId);
    }catch{/* A missing heartbeat makes readiness fail closed. */}try{await delay(10000,undefined,{signal:controller.signal});}catch{break;}}};
    try {
      await Promise.all([worker.run().finally(() => controller.abort()), new OutboxDispatcher(service, client).run(controller.signal),heartbeat()]);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    controller.abort();
    await clientConnection?.close();
    await nativeConnection?.close();
    await database.close();
  }
}

main().catch(() => {
  console.error('Intent worker failed to start or stopped unexpectedly. Check PostgreSQL and Temporal configuration.');
  process.exitCode = 1;
});
