import type { DeliveryEnvelope, DeliveryResult } from '@intent/domain';
import { requestJson } from '@intent/harness';

export async function deliverViaGateway(envelope: DeliveryEnvelope, send: typeof requestJson = requestJson): Promise<DeliveryResult> {
  try {
    const response = await send(envelope.endpoint, {
      operationId: envelope.action.operationId, revision: envelope.action.revision,
      from: envelope.sender, to: envelope.action.recipient,
      subject: envelope.action.subject, text: envelope.action.body,
    }, { authorization: `Bearer ${envelope.apiKey}`, 'idempotency-key': envelope.action.operationId }, 30000);
    if (!response || typeof response !== 'object' || Array.isArray(response)) return { outcome: 'unknown' };
    const keys = Object.keys(response);
    if (keys.length !== 2 || !keys.includes('status') || !keys.includes('reference') || !('status' in response) || !('reference' in response)) return { outcome: 'unknown' };
    if (response.status !== 'delivered' || typeof response.reference !== 'string') return { outcome: 'unknown' };
    const reference = response.reference.trim();
    if (reference.length < 3 || reference.length > 200) return { outcome: 'unknown' };
    return { outcome: 'delivered', reference };
  } catch {
    // A timeout or malformed response cannot prove that delivery did not occur.
    return { outcome: 'unknown' };
  }
}
