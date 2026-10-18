import { expect, it, vi } from 'vitest';
import { verifyWebhook } from '@faultline/sdk/webhooks';
import { deliverOutbox } from '../src/outbox';
import { setup, A } from '../../../packages/service/test/fixtures';
const secret = 'local-outbox-test-secret-'.repeat(3);
it('acknowledges only successful delivery and preserves identity on retry', async () => {
  const c = setup(); await c.service.createWorkflow(c.m, A, 'replay');
  const event = (await c.store.listOutbox())[0]!;
  let succeeds = false;
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    const headers = new Headers(options?.headers);
    expect(await verifyWebhook(String(options?.body), headers.get('Faultline-Signature')!, secret, Math.floor(c.now() / 1000))).toMatchObject({ id: event.id, type: event.type });
    expect(options?.redirect).toBe('error');
    expect(headers.get('Faultline-Event-Id')).toBe(event.id);
    return new Response('', { status: succeeds ? 200 : 503 });
  });
  const options = { url: 'https://receiver.example.test/faultline', secret, fetch: fetcher, now: c.now };
  expect(await deliverOutbox(c.store, options)).toEqual({ delivered: 0, pending: 1 });
  expect(await c.store.listOutbox()).toHaveLength(1);
  succeeds = true; c.advance(10000);
  expect(await deliverOutbox(c.store, options)).toEqual({ delivered: 1, pending: 0 });
  expect(await c.store.listOutbox()).toEqual([]);
  expect(await deliverOutbox(c.store, options)).toEqual({ delivered: 0, pending: 0 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not follow redirects or acknowledge a failed request', async () => {
  const c = setup(); await c.service.createWorkflow(c.m, A, 'replay');
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('redirect blocked'); });
  expect(await deliverOutbox(c.store, { url: 'https://receiver.example.test', secret, fetch: fetcher, now: c.now })).toEqual({ delivered: 0, pending: 1 });
  expect(await c.store.listOutbox()).toHaveLength(1);
  await expect(deliverOutbox(c.store, { url: 'http://receiver.example.test', secret, fetch: fetcher })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
