const utf8 = new TextEncoder();
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], value => parseInt(value, 16));
async function key(secret: string) {
  if (utf8.encode(secret).length < 32) throw new Error('Webhook secret requires at least 32 bytes');
  return crypto.subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signWebhook(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new Error('Invalid webhook timestamp');
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), utf8.encode(`${timestamp}.${body}`)));
  return `t=${timestamp},v1=${Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
/** Verify the raw request text before parsing. Persist/deduplicate the returned event ID. */
export async function verifyWebhook(body: string, signature: string, secret: string, now = Math.floor(Date.now() / 1000)) {
  if (utf8.encode(body).length > 1_048_576) throw new Error('Webhook body is too large');
  const match = /^t=([1-9][0-9]{0,12}),v1=([0-9a-f]{64})$/.exec(signature);
  if (!match || !Number.isSafeInteger(now) || Math.abs(now - Number(match[1])) > 300) throw new Error('Invalid or expired webhook signature');
  const valid = await crypto.subtle.verify('HMAC', await key(secret), bytes(match[2]!), utf8.encode(`${match[1]}.${body}`));
  if (!valid) throw new Error('Invalid webhook signature');
  const event = JSON.parse(body) as { id: string; workflowId: string; operationId: string; type: string; createdAt: number; payload: unknown };
  if (!event || typeof event.type !== 'string' || ![event.id, event.workflowId, event.operationId].every(id => typeof id === 'string' && /^0x[0-9a-f]{64}$/.test(id)) || !Number.isSafeInteger(event.createdAt)) throw new Error('Invalid webhook event');
  return event;
}
