import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { hashText } from '@faultline/protocol';
import { signWebhook, verifyWebhook } from '../src/webhooks';
const secret = 'local-webhook-test-secret-'.repeat(3), timestamp = 1900000000;
const body = JSON.stringify({ id: hashText('event'), workflowId: hashText('workflow'), operationId: hashText('operation'), type: 'operation.completed', createdAt: timestamp * 1000, payload: { operation: { status: 'completed' } } });
it('verifies the raw request against an independently computed HMAC', async () => {
  const expected = `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  expect(await signWebhook(body, secret, timestamp)).toBe(expected);
  expect((await verifyWebhook(body, expected, secret, timestamp)).id).toBe(hashText('event'));
});
it.each(['changed bytes', 'wrong secret', 'expired', 'future', 'malformed'])('rejects %s before consuming an event', async fault => {
  const signature = await signWebhook(body, secret, timestamp);
  await expect(verifyWebhook(fault === 'changed bytes' ? body + ' ' : body, fault === 'malformed' ? signature + ',v1=extra' : signature, fault === 'wrong secret' ? 'wrong-secret-'.repeat(4) : secret, timestamp + (fault === 'expired' ? 301 : fault === 'future' ? -301 : 0))).rejects.toThrow();
});
