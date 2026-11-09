import { setTimeout as delay } from 'node:timers/promises';
import { Client, WorkflowNotFoundError } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from '@temporalio/common';
import { WORKFLOW_QUEUE, workflowId, type OutboxEvent } from '@intent/contracts';
import type { IntentService } from '@intent/domain';
import { APPROVAL_SIGNAL, RECONCILIATION_SIGNAL } from './types.js';

export class OutboxDispatcher {
  private readonly retryAfter = new Map<string, { attempts: number; at: number }>();

  constructor(private readonly service: IntentService, private readonly client: Client, private readonly now = Date.now) {}

  async publish(event: OutboxEvent): Promise<void> {
    const id = workflowId(event.tenantId, event.payload.runId);
    try {
      await this.client.workflow.start('intentWorkflow', {
        workflowId: id,
        taskQueue: WORKFLOW_QUEUE,
        args: [{ tenantId: event.tenantId, runId: event.payload.runId }],
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    if (event.type !== 'plan.requested') {
      const revision = event.payload.revision;
      if (!Number.isSafeInteger(revision) || revision! <= 0) throw new Error('Outbox event has no valid revision');
      try {
        await this.client.workflow.getHandle(id).signal(event.type === 'action.approved' ? APPROVAL_SIGNAL : RECONCILIATION_SIGNAL, { revision });
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
        const action = await this.service.getActionForRun(event.tenantId, event.payload.runId);
        // A duplicate signal after completed history is harmless only with durable completion proof.
        if (action?.status !== 'cancelled' && (action?.status !== 'succeeded' || !action.receipt)) throw error;
      }
    }
    await this.service.markOutboxPublished(event.id);
  }

  async dispatchPending(signal?: AbortSignal): Promise<number> {
    // Exclude backoff rows in SQL, before LIMIT. Otherwise 100 failed old events
    // occupy every batch and prevent healthy later events from ever being read.
    const deferred = [...this.retryAfter].filter(([, retry]) => retry.at > this.now()).map(([id]) => id);
    const events = await this.service.listOutbox(100, deferred);
    let published = 0;
    for (const event of events) {
      if (signal?.aborted) break;
      const retry = this.retryAfter.get(event.id);
      if (retry && retry.at > this.now()) continue;
      try {
        if (signal) {
          await this.client.connection.withAbortSignal(signal, () =>
            this.client.connection.withDeadline(Date.now() + 10000, () => this.publish(event)));
        } else {
          await this.publish(event);
        }
        this.retryAfter.delete(event.id);
        published++;
      } catch {
        const attempts = Math.min((retry?.attempts ?? 0) + 1, 6);
        this.retryAfter.set(event.id, { attempts, at: this.now() + Math.min(1000 * 2 ** attempts, 30000) });
        console.error('Outbox event remains pending; retry scheduled. Other events will continue.');
      }
    }
    return published;
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.dispatchPending(signal);
        failures = 0;
      } catch {
        failures = Math.min(failures + 1, 6);
        console.error('Outbox publication unavailable; durable events remain pending.');
      }
      try {
        await delay(Math.min(1000 * 2 ** failures, 30000), undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }
}
