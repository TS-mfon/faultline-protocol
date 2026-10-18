import { MongoClient } from 'mongodb';
import { privateKeyToAccount } from 'viem/accounts';
import { LiveChainGateway, chainConfig } from '@faultline/chain';
import { FaultlineService, MongoStore, ProtocolError } from '@faultline/service';
import { DurableSigner, MongoSigningJournal, materialize, runOne, scheduleCleanup } from './index';
import { deliverOutbox } from './outbox';

const needed = (name: string) => {
  const value = process.env[name];
  if (!value) throw new ProtocolError('NOT_CONFIGURED', `${name} is required`);
  return value;
};

async function main() {
  const config = chainConfig(), account = privateKeyToAccount(needed('ATTESTOR_PRIVATE_KEY') as `0x${string}`);
  if (account.address.toLowerCase() !== config.attestor) throw new ProtocolError('ATTESTOR_MISMATCH', 'Attestor key/address mismatch');
  const client = new MongoClient(needed('MONGODB_URI'), { serverSelectionTimeoutMS: 15_000 });
  let processed = 0;
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DATABASE ?? 'faultline'), store = new MongoStore(client, db.databaseName);
    await store.initialize();
    const gateway = await new LiveChainGateway(config).verifyDeployments();
    const service = new FaultlineService(store, gateway, { evidenceOrigin: `${needed('PUBLIC_ORIGIN')}/api/v1/evidence`, workerActors: { base: config.attestor, genlayer: config.attestor } });
    const journal = new MongoSigningJournal(db);
    await journal.initialize();
    const signer = new DurableSigner(config, account, journal);
    try {
      await scheduleCleanup(store, service, gateway, config.attestor);
      for (; processed < 8; processed++) {
        const result = await runOne({ service, store, actor: config.attestor, owner: `worker-${process.pid}-${Date.now()}`, materialize: context => materialize(context, store, gateway, account), submit: (id, intent) => signer.submit(id, intent) });
        if (result === 'idle') break;
        console.log(JSON.stringify({ result }));
      }
    } finally {
      if (process.env.FAULTLINE_WEBHOOK_URL) {
        try { console.log(JSON.stringify({ outbox: await deliverOutbox(store, { url: process.env.FAULTLINE_WEBHOOK_URL, secret: needed('FAULTLINE_WEBHOOK_SECRET') }) })); }
        catch { console.error(JSON.stringify({ error: 'OUTBOX_CONFIGURATION', message: 'Outbox delivery remains pending' })); process.exitCode = 1; }
      }
    }
  } finally { await client.close(); }
  console.log(JSON.stringify({ processed, mode: 'live', payoutClaim: false }));
}

// Includes configuration and connection failures: driver errors can contain credentials.
void main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof ProtocolError ? error.code : 'WORKER_RETRY', message: 'Inspect the durable operation journal; signed payloads are not logged.' }));
  process.exitCode = 1;
});
