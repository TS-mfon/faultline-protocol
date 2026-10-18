import { canonical } from '@faultline/protocol';
import type { Store } from '@faultline/service';
import { signWebhook } from '@faultline/sdk/webhooks';

/** One operator-configured endpoint. Delivery is at least once; receivers deduplicate event IDs. */
export async function deliverOutbox(store: Store, options: { url: string; secret: string; fetch?: typeof fetch; now?: () => number; limit?: number }) {
  const url = new URL(options.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Webhook endpoint requires HTTPS without URL credentials');
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now;
  let delivered = 0, pending = 0;
  for (const event of await store.listOutbox(Math.min(20, Math.max(1, options.limit ?? 20)))) {
    const body = canonical({ id: event.id, workflowId: event.workflowId, operationId: event.operationId, type: event.type, createdAt: event.createdAt, payload: event.payload });
    const signature = await signWebhook(body, options.secret, Math.floor(now() / 1000));
    try {
      const response = await fetcher(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Faultline-Event-Id': event.id, 'Faultline-Signature': signature }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      await response.body?.cancel();
      if (!response.ok) { pending++; continue; }
      await store.acknowledgeOutbox(event.id, now()); delivered++;
    } catch { pending++; }
  }
  return { delivered, pending };
}
