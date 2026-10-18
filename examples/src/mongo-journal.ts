import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection, MongoClient } from 'mongodb';
import { hashCanonical, ProtocolError } from '@faultline/protocol';
import { MongoSigningJournal } from '@faultline/worker';
import type { RunState } from './live';
import type { EvidenceKind, ExampleStorage, RunEvidence } from './runner';

interface Control { _id: string; planHash: string; plan: unknown; cursor: number; revision: number; owner?: string; token?: string; leaseUntil?: number }
interface Checkpoint { _id: string; state: RunState }
interface Evidence { _id: string; hash: string; kind: EvidenceKind; value: RunEvidence }

/** One frozen nine-run suite; checkpoints and signed bytes survive GitHub runner replacement. */
export class MongoDemoStore implements ExampleStorage {
  readonly journal: MongoSigningJournal;
  private readonly control: Collection<Control>;
  private readonly runs: Collection<Checkpoint>;
  private readonly evidence: Collection<Evidence>;
  private token?: string;
  private planHash?: string;
  constructor(private readonly client: MongoClient, database: string, private readonly now = Date.now) {
    const db = client.db(database);
    this.control = db.collection('faultline_demo_control'); this.runs = db.collection('faultline_demo_runs'); this.evidence = db.collection('faultline_demo_evidence');
    this.journal = new MongoSigningJournal(db);
  }
  async initialize(plan: unknown) {
    const planHash = hashCanonical(plan);
    await this.control.updateOne({ _id: 'release' }, { $setOnInsert: { plan, planHash, cursor: 0, revision: 0 } }, { upsert: true });
    if ((await this.control.findOne({ _id: 'release' }))?.planHash !== planHash) throw new ProtocolError('DEMO_PLAN_IMMUTABLE', 'Run identities and deployments cannot change after scheduling');
    this.planHash = planHash; await this.journal.initialize();
  }
  async claim(owner: string, leaseMs = 120_000) {
    if (!this.planHash || !owner || leaseMs < 1000 || leaseMs > 600_000) throw new ProtocolError('INVALID_LEASE', 'Initialize a bounded demonstration lease');
    const token = randomUUID();
    const row = await this.control.findOneAndUpdate({ _id: 'release', planHash: this.planHash, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: this.now() } }] }, { $set: { owner, token, leaseUntil: this.now() + leaseMs }, $inc: { revision: 1 } }, { returnDocument: 'after' });
    if (!row) return null; this.token = token; return row.cursor;
  }
  private filter() {
    if (!this.token) throw new ProtocolError('LEASE_LOST', 'No demonstration lease is held');
    return { _id: 'release', planHash: this.planHash!, token: this.token, leaseUntil: { $gt: this.now() } };
  }
  async beforeSigning() { if (!await this.control.findOne(this.filter())) throw new ProtocolError('LEASE_LOST', 'Demonstration lease expired or was replaced'); }
  async renew(leaseMs = 120_000) {
    if (leaseMs < 1000 || leaseMs > 600_000) throw new ProtocolError('INVALID_LEASE', 'Invalid lease duration');
    if (!(await this.control.updateOne(this.filter(), { $set: { leaseUntil: this.now() + leaseMs }, $inc: { revision: 1 } })).matchedCount) throw new ProtocolError('LEASE_LOST', 'Demonstration lease expired or was replaced');
  }
  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        if (!(await this.control.updateOne(this.filter(), { $inc: { revision: 1 } }, { session })).matchedCount) throw new ProtocolError('LEASE_LOST', 'Stale runner cannot write checkpoints');
        return work(session);
      }) as T;
    } finally { await session.endSession(); }
  }
  async load(initial: RunState) {
    return this.transaction(async session => {
      await this.runs.updateOne({ _id: initial.manifest.id }, { $setOnInsert: { state: initial } }, { upsert: true, session });
      return (await this.runs.findOne({ _id: initial.manifest.id }, { session }))!.state;
    });
  }
  async save(state: RunState) {
    await this.transaction(async session => {
      const old = await this.runs.findOne({ _id: state.manifest.id }, { session });
      if (!old || hashCanonical(old.state.manifest) !== hashCanonical(state.manifest)) throw new ProtocolError('DEMO_PLAN_IMMUTABLE', 'Checkpoint terms cannot change');
      await this.runs.updateOne({ _id: state.manifest.id }, { $set: { state } }, { session });
    });
  }
  private evidenceId(kind: EvidenceKind, state: RunState) { return `${kind}:${state.domain}:${state.runId}`; }
  async readEvidence(kind: EvidenceKind, state: RunState) { return (await this.evidence.findOne({ _id: this.evidenceId(kind, state) }))?.value ?? null; }
  async publishEvidence(kind: EvidenceKind, state: RunState, value: RunEvidence) {
    const id = this.evidenceId(kind, state), hash = hashCanonical(value);
    await this.transaction(async session => {
      const old = await this.evidence.findOne({ _id: id }, { session });
      if (old) { if (old.hash !== hash) throw new ProtocolError('EVIDENCE_IMMUTABLE', 'Published evidence cannot change'); return; }
      await this.evidence.insertOne({ _id: id, hash, kind, value }, { session });
    });
  }
  async setCursor(cursor: number) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 8) throw new ProtocolError('INVALID_CURSOR', 'There are exactly nine scheduled demonstrations');
    await this.transaction(async session => { await this.control.updateOne({ _id: 'release' }, { $set: { cursor } }, { session }); });
  }
  async exportEvidence() { return this.evidence.find({}, { projection: { _id: 0, kind: 1, value: 1 } }).toArray(); }
  async release() {
    if (!this.token) return;
    await this.control.updateOne({ _id: 'release', token: this.token }, { $unset: { owner: '', token: '', leaseUntil: '' }, $inc: { revision: 1 } }); this.token = undefined;
  }
}
