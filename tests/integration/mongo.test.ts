import { it, expect } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoStore, FaultlineService } from '@faultline/service';
import { hashText } from '@faultline/protocol';
import { setup, A } from '../../packages/service/test/fixtures';

// Only an explicitly disposable replica set. No fallback to MONGODB_URI.
// Chain behavior is replay; these assertions verify real database behavior only.
it.skipIf(!process.env.MONGODB_TEST_URI)('Mongo transactions survive reconnect, roll back conflicts, fence stale workers and preserve GridFS bytes', async () => {
  const uri = process.env.MONGODB_TEST_URI!;
  const database = `faultline_ci_${crypto.randomUUID().replaceAll('-', '')}`;
  let client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    let store = new MongoStore(client, database);
    await store.initialize();
    const c = setup(), service = new FaultlineService(store, c.gateway, c.options);
    const create = () => service.withIdempotency('mongo-register', () => service.createWorkflow(c.m, A, 'replay'));
    const operations = await Promise.all([create(), create(), create()]);
    expect(new Set(operations.map(o => o.id)).size).toBe(1);
    expect(await store.listOperations(c.m.id)).toHaveLength(1);
    expect(await store.listOutbox()).toHaveLength(1);

    const evidence = new TextEncoder().encode('Exact public bytes: é');
    const hashes = await Promise.all([store.putEvidence(evidence), store.putEvidence(evidence)]);
    expect(hashes[0]).toBe(hashes[1]);
    await expect(store.putEvidence(evidence, hashText('different'))).rejects.toThrow();
    const job = { id: hashText('mongo-job'), workflowId: c.m.id, operationId: operations[0].id, kind: 'provision_escrow' as const, state: 'queued' as const, availableAt: c.now(), attempts: 0, revision: 0 };
    await store.commit({ jobs: [job] });

    // Close every connection used for writes before recreating the client/service.
    await client.close();
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    store = new MongoStore(client, database);
    await store.initialize();
    const restarted = new FaultlineService(store, c.gateway, c.options);
    expect(await restarted.getOperation(operations[0].id)).toEqual(operations[0]);
    expect(await restarted.withIdempotency('mongo-register', () => restarted.createWorkflow(c.m, A, 'replay'))).toEqual(operations[0]);
    expect(new Uint8Array((await store.getEvidence(hashes[0]))!)).toEqual(evidence);
    expect(await store.listOutbox()).toHaveLength(1);

    const before = (await store.getWorkflow(c.m.id))!;
    const changed = structuredClone(before);
    changed.record.revision++;
    changed.record.status = 'funding';
    const operation = (await store.getOperation(operations[0].id))!;
    // The workflow write succeeds first, then a stale operation revision aborts it.
    const staleRevision = operation.revision + 1;
    operation.revision = staleRevision + 1;
    await expect(store.commit({
      workflow: { expectedRevision: before.record.revision, value: changed },
      operations: [{ expectedRevision: staleRevision, value: operation }],
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await store.getWorkflow(c.m.id)).toEqual(before);
    expect(await restarted.getOperation(operations[0].id)).toEqual(operations[0]);

    const old = (await store.claimJob('old', c.now(), 1000))!;
    const fresh = (await store.claimJob('new', c.now() + 1001, 1000))!;
    expect(fresh.id).toBe(job.id);
    expect(fresh.leaseToken).not.toBe(old.leaseToken);
    await expect(store.commit({
      lease: { id: old.id, owner: old.leaseOwner, token: old.leaseToken, now: c.now() + 1002 },
      workflow: { expectedRevision: before.record.revision, value: changed },
    })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await store.getWorkflow(c.m.id)).toEqual(before);
    await store.commit({ lease: { id: fresh.id, owner: fresh.leaseOwner, token: fresh.leaseToken, now: c.now() + 1002, complete: true } });
    expect(await store.claimJob('later', c.now() + 5000, 1000)).toBeNull();
  } finally {
    try { await client.db(database).dropDatabase(); } finally { await client.close(); }
  }
}, 30000);
