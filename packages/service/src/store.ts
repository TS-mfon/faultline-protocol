import { randomBytes } from 'node:crypto';
import { hashBytes, hashCanonical, HashSchema } from '@faultline/protocol';
import { check, parse, ProtocolError } from './errors';
import type { AuthChallenge, ChangeSet, DurableJob, IdempotencyRecord, JobLease, OutboxEvent, Store, StoredOperation, StoredWorkflow } from './types';

export const copy = <T>(value: T): T => structuredClone(value);
export const idempotencyId = (scope: string, key: string) => hashCanonical([scope, key]);
export function validateIdempotencyKey(key: string): void {
  check(typeof key === 'string' && /^[\x21-\x7e]{1,200}$/.test(key), 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1–200 printable non-space ASCII characters');
}
export async function findIdempotentOperation(store: Store, scope: string, key: string, requestHash: string): Promise<StoredOperation | null> {
  validateIdempotencyKey(key);
  const found = await store.getIdempotency(scope, key);
  if (!found) return null;
  check(found.requestHash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request');
  const op = await store.getOperation(found.operationId);
  check(op, 'STORE_CORRUPTION', 'Idempotency record has no operation');
  return op;
}
export function evidenceHash(bytes: Uint8Array, expectedHash?: string): string {
  check(bytes.byteLength > 0 && bytes.byteLength <= 65_536, 'EVIDENCE_TOO_LARGE', 'Evidence must contain 1–65536 bytes');
  const actual = hashBytes(bytes);
  if (expectedHash !== undefined) check(actual === parse(HashSchema, expectedHash), 'EVIDENCE_HASH', 'Evidence bytes do not match their hash');
  return actual;
}
export function leaseDuration(value: number): void {
  check(Number.isSafeInteger(value) && value > 0 && value <= 3_600_000, 'INVALID_LEASE', 'Lease duration must be 1–3600000 milliseconds');
}
export function validClock(now: number): void { check(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME', 'Clock must be an integer Unix millisecond timestamp'); }
export function assertLease(job: DurableJob | undefined, owner: string, token: string, now: number): asserts job is JobLease {
  validClock(now);
  check(job?.state === 'leased' && job.leaseOwner === owner && job.leaseToken === token && job.leaseUntil! > now, 'LEASE_LOST', 'Job lease is expired or belongs to another worker');
}
function revision(actual: number | undefined, expected: number | null): void {
  check(expected === null ? actual === undefined : actual === expected, 'REVISION_CONFLICT', 'Stored revision changed; reload before retrying');
}
/** Explicitly in-process and non-durable. Never use for live workflows or production auth. */
export class MemoryStore implements Store {
  readonly durability = 'memory' as const;
  private workflows = new Map<string, StoredWorkflow>();
  private operations = new Map<string, StoredOperation>();
  private jobs = new Map<string, DurableJob>();
  private outbox = new Map<string, OutboxEvent>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private evidence = new Map<string, Uint8Array>();
  private challenges = new Map<string, AuthChallenge>();
  constructor(options: { purpose: 'test' | 'replay' }) {
    check(options?.purpose === 'test' || options?.purpose === 'replay', 'MEMORY_TEST_ONLY', 'MemoryStore requires an explicit test or replay purpose');
  }
  async getWorkflow(id: string) { return copy(this.workflows.get(id) ?? null); }
  async listWorkflows() { return copy([...this.workflows.values()]); }
  async getOperation(id: string) { return copy(this.operations.get(id) ?? null); }
  async listOperations(id: string) { return copy([...this.operations.values()].filter(o => o.operation.workflowId === id)); }
  async getIdempotency(scope: string, key: string) { return copy(this.idempotency.get(idempotencyId(scope, key)) ?? null); }
  async commit(input: ChangeSet): Promise<void> {
    // No await between preflight and mutations: this is one atomic in-process critical section.
    const c = copy(input);
    if (c.idempotency) {
      const old = this.idempotency.get(idempotencyId(c.idempotency.scope, c.idempotency.key));
      if (old) throw new ProtocolError(old.requestHash === c.idempotency.requestHash ? 'REVISION_CONFLICT' : 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key already exists');
    }
    if (c.lease) assertLease(this.jobs.get(c.lease.id), c.lease.owner, c.lease.token, c.lease.now);
    if (c.workflow) {
      check(c.workflow.value.record.mode === 'replay', 'MEMORY_LIVE_FORBIDDEN', 'MemoryStore cannot persist a live workflow');
      revision(this.workflows.get(c.workflow.value.record.manifest.id)?.record.revision, c.workflow.expectedRevision);
      check(c.workflow.value.record.revision === (c.workflow.expectedRevision ?? -1) + 1, 'INVALID_REVISION', 'Workflow revision must increment exactly once');
    }
    check(new Set(c.operations?.map(o => o.value.operation.id)).size === (c.operations?.length ?? 0), 'DUPLICATE_OPERATION', 'Duplicate operation in transaction');
    for (const o of c.operations ?? []) {
      revision(this.operations.get(o.value.operation.id)?.revision, o.expectedRevision);
      check(o.value.revision === (o.expectedRevision ?? -1) + 1, 'INVALID_REVISION', 'Operation revision must increment exactly once');
    }
    for (const j of c.jobs ?? []) check(!this.jobs.has(j.id), 'REVISION_CONFLICT', 'Job already exists');
    for (const e of c.outbox ?? []) check(!this.outbox.has(e.id), 'REVISION_CONFLICT', 'Event already exists');
    if (c.workflow) this.workflows.set(c.workflow.value.record.manifest.id, c.workflow.value);
    for (const o of c.operations ?? []) this.operations.set(o.value.operation.id, o.value);
    for (const j of c.jobs ?? []) this.jobs.set(j.id, j);
    for (const e of c.outbox ?? []) this.outbox.set(e.id, e);
    if (c.idempotency) this.idempotency.set(idempotencyId(c.idempotency.scope, c.idempotency.key), c.idempotency);
    if (c.lease?.complete) {
      const j = this.jobs.get(c.lease.id)!;
      j.state = 'completed'; j.revision++; delete j.leaseUntil; delete j.leaseToken; delete j.leaseOwner;
    }
  }
  async claimJob(owner: string, now: number, leaseMs: number): Promise<JobLease | null> {
    leaseDuration(leaseMs); validClock(now); check(owner.length > 0, 'INVALID_OWNER', 'Worker owner is required');
    const j = [...this.jobs.values()].sort((a,b) => a.availableAt-b.availableAt || a.id.localeCompare(b.id)).find(j => (j.state === 'queued' && j.availableAt <= now) || (j.state === 'leased' && j.leaseUntil! <= now));
    if (!j) return null;
    Object.assign(j, { state: 'leased', leaseOwner: owner, leaseToken: randomBytes(24).toString('hex'), leaseUntil: now + leaseMs, attempts: j.attempts + 1, revision: j.revision + 1 });
    return copy(j as JobLease);
  }
  async renewLease(id: string, owner: string, token: string, now: number, leaseMs: number): Promise<JobLease> {
    leaseDuration(leaseMs); const j = this.jobs.get(id); assertLease(j,owner,token,now);
    j.leaseUntil = now + leaseMs; j.revision++; return copy(j);
  }
  async retryJob(id: string, owner: string, token: string, now: number, availableAt: number): Promise<void> {
    validClock(availableAt); check(availableAt >= now, 'INVALID_TIME', 'Retry cannot be scheduled in the past');
    const j = this.jobs.get(id); assertLease(j,owner,token,now);
    const released: DurableJob = j; released.state = 'queued'; released.availableAt = availableAt; released.revision++; delete released.leaseUntil; delete released.leaseToken; delete released.leaseOwner;
  }
  async listOutbox(limit = 100) { return copy([...this.outbox.values()].filter(e => e.deliveredAt === undefined).slice(0, Math.max(0, Math.min(1000, limit)))); }
  async acknowledgeOutbox(id: string, deliveredAt: number) { validClock(deliveredAt); const e = this.outbox.get(id); check(e, 'NOT_FOUND', 'Outbox event not found'); e.deliveredAt ??= deliveredAt; }
  async putEvidence(bytes: Uint8Array, expectedHash?: string) { const hash = evidenceHash(bytes,expectedHash); if (!this.evidence.has(hash)) this.evidence.set(hash,copy(bytes)); return hash; }
  async getEvidence(hash: string) { parse(HashSchema,hash); const data = this.evidence.get(hash); if (data) check(hashBytes(data) === hash,'EVIDENCE_CORRUPT','Stored evidence hash mismatch'); return data ? copy(data) : null; }
  async putChallenge(c: AuthChallenge) { check(!this.challenges.has(c.id),'REVISION_CONFLICT','Challenge already exists'); this.challenges.set(c.id,copy(c)); }
  async getChallenge(id: string) { return copy(this.challenges.get(id) ?? null); }
  async consumeChallenge(id: string, now: number) {
    const c = this.challenges.get(id); if (!c || c.consumedAt !== undefined || c.expiresAt <= now) return false;
    c.consumedAt = now; return true;
  }
}
