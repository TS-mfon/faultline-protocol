import { expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { keccak256 } from 'viem';
import { MongoDemoStore } from '../../examples/src/mongo-journal';
import { initialState } from '../../examples/src/live';
import { artifact } from '../../examples/src/artifacts';
import { executeTask } from '../../examples/src/tasks';
import { replay, scenarios } from '../../examples/src/scenarios';
import { hashCanonical, hashText } from '@faultline/protocol';

// Real disposable MongoDB, deterministic task/replay fixtures. No network judgment is implied.
it.skipIf(!process.env.MONGODB_TEST_URI)('scheduled demos preserve signed records and checkpoints, fence stale owners and freeze evidence across reconnect', async () => {
  const database = `faultline_demo_ci_${crypto.randomUUID().replaceAll('-', '')}`;
  let client = new MongoClient(process.env.MONGODB_TEST_URI!, { serverSelectionTimeoutMS: 5000 });
  let now = Date.now();
  try {
    await client.connect();
    const fixture = replay('software'), actors = { creator: fixture.manifest.creator, agents: fixture.manifest.nodes.map(node => node.agent) as [string, string, string], repairer: fixture.manifest.repairs[0].recipient };
    const state = initialState('software', actors, 'durable-mongo-test'), plan = { workflowHash: hashCanonical(state.manifest) };
    const first = new MongoDemoStore(client, database, () => now);
    await first.initialize(plan); expect(await first.claim('first', 1000)).toBe(0);
    await first.load(state);
    state.operations.register = { id: hashText('registered operation'), txHash: hashText('mock chain hash') };
    const source = scenarios.software.source;
    const produce = executeTask({ domain: 'software', task: 'produce', source });
    const review = executeTask({ domain: 'software', task: 'review', source, upstream: produce.text });
    const publish = executeTask({ domain: 'software', task: 'publish', source, upstream: review.text });
    for (const output of [produce, review, publish]) state.work[output.input.task] = { state: 'complete', output };
    await first.save(state); await first.setCursor(3);
    const record = { _id: hashText('mock signature'), intentHash: hashText('mock intent'), chainId: 4221, from: actors.creator, nonce: 7, raw: '0x1234' as const, evmHash: keccak256('0x1234') };
    await first.journal.insert(record);
    const older = { ...record, _id: hashText('earlier signature'), nonce: 6 };
    await first.journal.insert(older);
    await first.journal.insert({ ...record, _id: hashText('another chain'), chainId: 84532, nonce: 50 });
    await first.journal.insert({ ...record, _id: hashText('another signer'), from: actors.repairer, nonce: 60 });
    const evidence = artifact(state, { mode: 'replay', workflow: { manifest: state.manifest, mode: 'replay', hash: plan.workflowHash }, operations: [], snapshots: [] }, 'consensus');
    await first.publishEvidence('consensus', state, evidence);
    await first.publishEvidence('consensus', state, evidence);
    const second = new MongoDemoStore(client, database, () => now);
    await second.initialize(plan); expect(await second.claim('second', 1000)).toBeNull();
    await expect(second.initialize({ workflowHash: hashText('changed plan') })).rejects.toMatchObject({ code: 'DEMO_PLAN_IMMUTABLE' });
    now += 1001; expect(await second.claim('second', 1000)).toBe(3);
    await expect(first.beforeSigning()).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(first.save({ ...state, outcome: 'stale write' })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(first.publishEvidence('consensus', state, evidence)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(second.publishEvidence('consensus', state, { ...evidence, runId: 'changed' })).rejects.toMatchObject({ code: 'EVIDENCE_IMMUTABLE' });
    await first.release(); await second.beforeSigning(); // A stale release cannot clear its successor's lease.
    await client.close();
    client = new MongoClient(process.env.MONGODB_TEST_URI!, { serverSelectionTimeoutMS: 5000 }); await client.connect();
    now += 1001;
    const restarted = new MongoDemoStore(client, database, () => now); await restarted.initialize(plan);
    expect(await restarted.claim('restarted', 1000)).toBe(3);
    expect(await restarted.load(initialState('software', actors, 'durable-mongo-test'))).toEqual(state);
    expect(await restarted.journal.get(record._id)).toEqual(record);
    expect(await restarted.journal.latestNonce(4221, actors.creator)).toBe(7);
    expect(await restarted.journal.latest(4221, actors.creator)).toEqual(record);
    expect(await restarted.journal.latest(84532, actors.repairer)).toBeNull();
    expect(await restarted.readEvidence('consensus', state)).toEqual(evidence);
    expect(await restarted.exportEvidence()).toHaveLength(1);
    await restarted.release();
  } finally { try { await client.db(database).dropDatabase(); } finally { await client.close(); } }
}, 30000);
