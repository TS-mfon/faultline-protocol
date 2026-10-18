import { randomBytes } from 'node:crypto';
import { GridFSBucket, MongoClient, type ClientSession, type Collection, type Db, type ObjectId } from 'mongodb';
import { hashBytes, HashSchema } from '@faultline/protocol';
import { check, parse, ProtocolError } from './errors';
import { evidenceHash, idempotencyId, leaseDuration, validClock } from './store';
import type { AuthChallenge, ChangeSet, DurableJob, IdempotencyRecord, JobLease, OutboxEvent, Store, StoredOperation, StoredWorkflow } from './types';

type Row<T> = { _id: string; value: T };
type JobRow = DurableJob & { _id: string };
type EventRow = OutboxEvent & { _id: string };
type ChallengeRow = AuthChallenge & { _id: string; cleanupAt: Date };
const duplicate = (error: unknown) => (error as { code?: number })?.code === 11000;
/** MongoDB Atlas / replica set required: all state, job and outbox changes use transactions.
 * GridFS objects are published only after upload finishes. Readers resolve immutable hash->file IDs.
 * Application DB credentials must deny mutation of published evidence outside this adapter.
 */
export class MongoStore implements Store {
  readonly durability = 'durable' as const;
  private readonly db: Db;
  private readonly workflows: Collection<Row<StoredWorkflow>>;
  private readonly operations: Collection<Row<StoredOperation>>;
  private readonly jobs: Collection<JobRow>;
  private readonly events: Collection<EventRow>;
  private readonly keys: Collection<Row<IdempotencyRecord>>;
  private readonly challenges: Collection<ChallengeRow>;
  private readonly evidence: Collection<{ _id: string; fileId: ObjectId; length: number }>;
  private readonly bucket: GridFSBucket;
  constructor(private readonly client: MongoClient, databaseName: string, prefix = 'faultline') {
    check(/^[a-zA-Z0-9_-]{1,64}$/.test(prefix) && databaseName.length > 0, 'STORE_CONFIGURATION', 'A database name and valid collection prefix are required');
    this.db = client.db(databaseName);
    this.workflows = this.db.collection(`${prefix}_workflows`); this.operations = this.db.collection(`${prefix}_operations`);
    this.jobs = this.db.collection(`${prefix}_jobs`); this.events = this.db.collection(`${prefix}_outbox`);
    this.keys = this.db.collection(`${prefix}_idempotency`); this.challenges = this.db.collection(`${prefix}_challenges`);
    this.evidence = this.db.collection(`${prefix}_evidence`); this.bucket = new GridFSBucket(this.db,{ bucketName: `${prefix}_blobs`, writeConcern: { w: 'majority' } });
  }
  static async connect(uri: string, databaseName: string): Promise<MongoStore> {
    check(/^mongodb(\+srv)?:\/\//.test(uri), 'STORE_CONFIGURATION', 'A MongoDB connection URI is required');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
    try { await client.connect(); const store = new MongoStore(client,databaseName); await store.initialize(); return store; }
    catch (error) { await client.close(); throw error; }
  }
  async initialize(): Promise<void> {
    await Promise.all([
      this.operations.createIndex({ 'value.operation.workflowId': 1 }),
      this.jobs.createIndex({ state: 1, availableAt: 1, leaseUntil: 1 }),
      this.events.createIndex({ deliveredAt: 1, createdAt: 1 }),
      this.challenges.createIndex({ cleanupAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  }
  async close(): Promise<void> { await this.client.close(); }
  async getWorkflow(id: string) { return (await this.workflows.findOne({ _id: id }))?.value ?? null; }
  async listWorkflows() { return (await this.workflows.find().sort({ 'value.record.createdAt': -1, _id: 1 }).toArray()).map(x => x.value); }
  async getOperation(id: string) { return (await this.operations.findOne({ _id: id }))?.value ?? null; }
  async listOperations(workflowId: string) { return (await this.operations.find({ 'value.operation.workflowId': workflowId }).toArray()).map(x => x.value); }
  async getIdempotency(scope: string, key: string) { return (await this.keys.findOne({ _id: idempotencyId(scope,key) }))?.value ?? null; }
  async commit(c: ChangeSet): Promise<void> {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        if (c.lease) {
          const l = c.lease;
          const result = await this.jobs.updateOne(this.leaseFilter(l.id,l.owner,l.token,l.now), l.complete ? { $set: { state: 'completed' }, $inc: { revision: 1 }, $unset: { leaseOwner: '', leaseToken: '', leaseUntil: '' } } : { $inc: { revision: 1 } }, { session });
          check(result.matchedCount === 1,'LEASE_LOST','Job lease expired or was reclaimed');
        }
        if (c.idempotency) await this.keys.insertOne({ _id: idempotencyId(c.idempotency.scope,c.idempotency.key), value: c.idempotency }, { session });
        if (c.workflow) {
          const { value, expectedRevision } = c.workflow;
          check(value.record.revision === (expectedRevision ?? -1) + 1,'INVALID_REVISION','Workflow revision must increment exactly once');
          await this.replace(this.workflows,value.record.manifest.id,value,expectedRevision,'value.record.revision',session);
        }
        check(new Set(c.operations?.map(o => o.value.operation.id)).size === (c.operations?.length ?? 0),'DUPLICATE_OPERATION','Duplicate operation in transaction');
        for (const { value, expectedRevision } of c.operations ?? []) {
          check(value.revision === (expectedRevision ?? -1) + 1,'INVALID_REVISION','Operation revision must increment exactly once');
          await this.replace(this.operations,value.operation.id,value,expectedRevision,'value.revision',session);
        }
        if (c.jobs?.length) await this.jobs.insertMany(c.jobs.map(j => ({ ...j, _id: j.id })), { session });
        if (c.outbox?.length) await this.events.insertMany(c.outbox.map(e => ({ ...e, _id: e.id })), { session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    } catch (error) {
      if (duplicate(error)) {
        if (c.idempotency) {
          const old = await this.getIdempotency(c.idempotency.scope,c.idempotency.key);
          if (old && old.requestHash !== c.idempotency.requestHash) throw new ProtocolError('IDEMPOTENCY_CONFLICT','Idempotency-Key was already used for a different request');
        }
        throw new ProtocolError('REVISION_CONFLICT','Concurrent insert won; reload before retrying');
      }
      throw error;
    } finally { await session.endSession(); }
  }
  private async replace<T extends object>(collection: Collection<Row<T>>, id: string, value: T, expected: number | null, path: string, session: ClientSession) {
    if (expected === null) { await collection.insertOne({ _id: id, value },{ session }); return; }
    const result = await collection.replaceOne({ _id: id, [path]: expected }, { value }, { session });
    check(result.matchedCount === 1,'REVISION_CONFLICT','Stored revision changed; reload before retrying');
  }
  private leaseFilter(id: string, owner: string, token: string, now: number) {
    validClock(now); return { _id: id, state: 'leased' as const, leaseOwner: owner, leaseToken: token, leaseUntil: { $gt: now } };
  }
  async claimJob(owner: string, now: number, leaseMs: number): Promise<JobLease | null> {
    leaseDuration(leaseMs); validClock(now); check(owner.length > 0,'INVALID_OWNER','Worker owner is required');
    return await this.jobs.findOneAndUpdate({ $or: [{ state: 'queued', availableAt: { $lte: now } }, { state: 'leased', leaseUntil: { $lte: now } }] }, { $set: { state: 'leased', leaseOwner: owner, leaseToken: randomBytes(24).toString('hex'), leaseUntil: now+leaseMs }, $inc: { attempts: 1, revision: 1 } }, { sort: { availableAt: 1, _id: 1 }, returnDocument: 'after', includeResultMetadata: false }) as JobLease | null;
  }
  async renewLease(id: string, owner: string, token: string, now: number, leaseMs: number): Promise<JobLease> {
    leaseDuration(leaseMs);
    const j = await this.jobs.findOneAndUpdate(this.leaseFilter(id,owner,token,now), { $set: { leaseUntil: now+leaseMs }, $inc: { revision: 1 } }, { returnDocument: 'after', includeResultMetadata: false });
    check(j,'LEASE_LOST','Job lease expired or was reclaimed'); return j as JobLease;
  }
  async retryJob(id: string, owner: string, token: string, now: number, availableAt: number) {
    validClock(availableAt); check(availableAt >= now,'INVALID_TIME','Retry cannot be scheduled in the past');
    const result = await this.jobs.updateOne(this.leaseFilter(id,owner,token,now), { $set: { state: 'queued', availableAt }, $unset: { leaseOwner: '', leaseToken: '', leaseUntil: '' }, $inc: { revision: 1 } });
    check(result.matchedCount === 1,'LEASE_LOST','Job lease expired or was reclaimed');
  }
  async listOutbox(limit = 100): Promise<OutboxEvent[]> { return this.events.find({ deliveredAt: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).limit(Math.max(1,Math.min(1000,limit))).toArray(); }
  async acknowledgeOutbox(id: string, deliveredAt: number) {
    validClock(deliveredAt);
    const result = await this.events.updateOne({ _id: id, deliveredAt: { $exists: false } }, { $set: { deliveredAt } });
    check(result.matchedCount || await this.events.findOne({ _id: id }),'NOT_FOUND','Outbox event not found');
  }
  async putEvidence(bytes: Uint8Array, expectedHash?: string): Promise<string> {
    // Copy before the first await so callers cannot mutate bytes during upload.
    const immutable = Buffer.from(bytes), hash = evidenceHash(immutable,expectedHash);
    if (await this.evidence.findOne({ _id: hash })) { await this.getEvidence(hash); return hash; }
    const upload = this.bucket.openUploadStream(hash, { metadata: { hash, immutable: true } });
    try {
      await new Promise<void>((resolve,reject) => { upload.once('error',reject); upload.once('finish',resolve); upload.end(immutable); });
      await this.evidence.insertOne({ _id: hash, fileId: upload.id, length: immutable.length }, { writeConcern: { w: 'majority' } });
    } catch (error) {
      // A racing upload can only delete its own unpublished blob. Never replace a published file.
      await this.bucket.delete(upload.id).catch(() => undefined);
      if (!duplicate(error)) throw error;
      await this.getEvidence(hash);
    }
    return hash;
  }
  async getEvidence(hash: string): Promise<Uint8Array | null> {
    parse(HashSchema,hash); const pointer = await this.evidence.findOne({ _id: hash }); if (!pointer) return null;
    const chunks: Buffer[] = []; let length = 0;
    const stream = this.bucket.openDownloadStream(pointer.fileId);
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > 65_536) { stream.destroy(); throw new ProtocolError('EVIDENCE_CORRUPT','Stored evidence exceeds the protocol limit'); }
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);
    check(data.length === pointer.length && hashBytes(data) === hash,'EVIDENCE_CORRUPT','Stored evidence hash mismatch'); return data;
  }
  async putChallenge(c: AuthChallenge) { await this.challenges.insertOne({ ...c, _id: c.id, cleanupAt: new Date(c.expiresAt) }); }
  async getChallenge(id: string): Promise<AuthChallenge | null> { return this.challenges.findOne({ _id: id }); }
  async consumeChallenge(id: string, now: number) {
    validClock(now);
    const result = await this.challenges.updateOne({ _id: id, expiresAt: { $gt: now }, consumedAt: { $exists: false } }, { $set: { consumedAt: now } });
    return result.modifiedCount === 1;
  }
}
