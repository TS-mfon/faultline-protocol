import { ProtocolError, MAX_EVIDENCE_BYTES, HashSchema, AddressSchema, hashText } from '@faultline/protocol';
import type { FaultlineService, Store, WalletAuth } from '@faultline/service';

export type HttpRuntime = { service: FaultlineService; store: Store; auth: WalletAuth };
const reply = (data: unknown, status = 200) => Response.json({ data }, { status, headers: { 'Cache-Control': 'no-store' } });
const statuses: Record<string, number> = { NOT_FOUND: 404, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_CONFIGURED: 503, IDEMPOTENCY_CONFLICT: 409, REVISION_CONFLICT: 409, BODY_TOO_LARGE: 413 };
export async function bodyJson(request: Request): Promise<any> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ProtocolError('INVALID_CONTENT_TYPE', 'Use application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new ProtocolError('INVALID_JSON', 'A JSON request body is required');
  let count = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; count += value.length; if (count > MAX_EVIDENCE_BYTES) { await reader.cancel(); throw new ProtocolError('BODY_TOO_LARGE', 'Request exceeds 64 KiB'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new ProtocolError('INVALID_JSON', 'Body must be valid UTF-8 JSON'); }
}

/** Same router is tested in-process and used by Next. It never signs a transaction. */
export function createHttpHandler(resolveRuntime: () => Promise<HttpRuntime | null>) {
  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean);
      if (request.method === 'GET' && parts.join('/') === 'health') {
        const configured = Boolean(process.env.MONGODB_URI && process.env.GENLAYER_CONTRACT_ADDRESS && process.env.BASE_ESCROW_ADDRESS);
        return reply({ name: 'Faultline Protocol', version: 1, configured, network: 'testnet', liveVerified: false });
      }
      const runtime = await resolveRuntime();
      if (!runtime) throw new ProtocolError('NOT_CONFIGURED', 'Live service is not configured. Replay examples remain available in the interface.');
      const { service, store, auth } = runtime;
      if (request.method === 'GET') {
        if (parts[0] === 'workflows' && parts.length === 1) return reply(await service.listWorkflows());
        if (parts[0] === 'workflows' && parts.length === 2) return reply(await service.getWorkflow(HashSchema.parse(parts[1])));
        if (parts[0] === 'workflows' && parts[2] === 'audit' && parts.length === 3) return reply(await service.exportAudit(HashSchema.parse(parts[1])));
        if (parts[0] === 'operations' && parts.length === 2) return reply(await service.getOperation(parts[1]!));
        if (parts[0] === 'operations' && parts.length === 3 && parts[2] === 'finality') return reply(await service.getOperationFinality(HashSchema.parse(parts[1])));
        if (parts[0] === 'agents' && parts[2] === 'reputation' && parts.length === 3) return reply(await service.getReputation(AddressSchema.parse(parts[1])));
        if (parts[0] === 'evidence' && parts.length === 2) {
          const hash = HashSchema.parse(parts[1]); const bytes = await store.getEvidence(hash);
          if (!bytes) throw new ProtocolError('NOT_FOUND', 'Evidence not found');
          return new Response(bytes as BodyInit, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${hash}.bin"`, ETag: `"${hash}"`, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
        }
      }
      if (request.method !== 'POST') throw new ProtocolError('NOT_FOUND', 'Route not found');
      const body = await bodyJson(request);
      if (parts.join('/') === 'auth/challenge') return reply(await auth.createChallenge(AddressSchema.parse(body.address)));
      if (parts.join('/') === 'auth/verify') return reply(await auth.verifyChallenge(body.id, body.signature));
      const { address: actor } = auth.verifyBearer(request.headers.get('authorization') ?? '');
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9_:.-]{1,128}$/.test(key)) throw new ProtocolError('INVALID_IDEMPOTENCY_KEY', 'Provide an Idempotency-Key of 1–128 letters, numbers, underscores, colons, dots or hyphens');
      return reply(await service.withIdempotency(key, async () => {
        if(parts.join('/')==='artifacts'){
          if(typeof body.text!=='string'||!body.text.length)throw new ProtocolError('INVALID_INPUT','Artifact text is required');
          const hash=hashText(body.text);if(body.hash&&body.hash!==hash)throw new ProtocolError('EVIDENCE_HASH','Artifact hash does not match text');
          await store.putEvidence(new TextEncoder().encode(body.text),hash);return {hash};
        }
        if (parts[0] === 'workflows' && parts.length === 1) return service.createWorkflow(body.manifest ?? body, actor, 'live');
        if (parts[0] === 'operations' && parts[2] === 'confirm' && parts.length === 3) return service.confirmOperation(parts[1]!, HashSchema.parse(body.txHash), actor);
        if (parts[0] !== 'workflows' || parts.length !== 3) throw new ProtocolError('NOT_FOUND', 'Route not found');
        const id = HashSchema.parse(parts[1]);
        switch (parts[2]) {
          case 'accept': return service.prepareAcceptance(id, actor);
          case 'fund': return service.prepareFunding(id, actor);
          case 'handoffs': return service.publishHandoff(id, body, actor);
          case 'acknowledgments': return service.acknowledgeHandoff(id, HashSchema.parse(body.handoffId), actor);
          case 'failures': return service.reportFailure(id, body, actor);
          case 'evidence': return service.addEvidence(id, body, actor);
          case 'close-evidence': return service.closeEvidence(id, actor);
          case 'adjudicate': return service.requestAdjudication(id, actor);
          case 'repairs': return service.submitRepair(id, body, actor);
          default: throw new ProtocolError('NOT_FOUND', 'Route not found');
        }
      }), 202);
    } catch (error) {
      if (error instanceof ProtocolError) return Response.json({ error: { code: error.code, message: error.message } }, { status: statuses[error.code] ?? 400 });
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError') return Response.json({ error: { code: 'INVALID_INPUT', message: 'Request fields are invalid' } }, { status: 400 });
      console.error('Faultline API failed', error instanceof Error ? error.name : 'UnknownError');
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Request could not be completed' } }, { status: 500 });
    }
  };
}
