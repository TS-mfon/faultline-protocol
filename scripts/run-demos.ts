import { MongoClient } from 'mongodb';
import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chainConfig, LiveChainGateway } from '@faultline/chain';
import { hashCanonical, ProtocolError } from '@faultline/protocol';
import { domains } from '../examples/src/scenarios';
import { exampleRunner } from '../examples/src/runner';
import { MongoDemoStore } from '../examples/src/mongo-journal';
import { atomicJson, immutableJson } from '../examples/src/journal';

async function main() {
  if (process.env.FAULTLINE_DEMOS_ENABLED !== 'true') throw new ProtocolError('DEMOS_DISABLED', 'Enable the protected testnet demonstration runner explicitly');
  const prefix = process.env.FAULTLINE_DEMO_RUN_PREFIX;
  if (!prefix || !/^[\w-]{1,60}$/.test(prefix) || !process.env.MONGODB_URI) throw new ProtocolError('NOT_CONFIGURED', 'A stable run prefix and dedicated MongoDB configuration are required');
  const config = chainConfig(), gateway = await new LiveChainGateway(config).verifyDeployments(), runner = exampleRunner(config, gateway);
  const runs = [1, 2, 3].flatMap(attempt => domains.map(domain => ({ domain, runId: `${prefix}-${attempt}` })));
  const plan = { schemaVersion: 1, deployments: gateway.deployments, runs: runs.map(run => ({ ...run, workflowHash: hashCanonical(runner.initial(run.domain, run.runId).manifest) })) };
  const client = await MongoClient.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
  const store = new MongoDemoStore(client, process.env.MONGODB_DATABASE ?? 'faultline');
  let timer: NodeJS.Timeout | undefined, leaseLost = false;
  const results: Record<string, unknown>[] = [];
  try {
    await store.initialize(plan);
    const cursor = await store.claim(`demo-${randomUUID()}`);
    if (cursor === null) { console.log(JSON.stringify({ mode: 'live', stage: 'another-runner-holds-lease' })); return; }
    timer = setInterval(() => { store.renew().catch(() => { leaseLost = true; }); }, 30_000);
    const stopAt = Date.now() + 240_000;
    for (let offset = 0; offset < runs.length && Date.now() < stopAt; offset++) {
      if (leaseLost) throw new ProtocolError('LEASE_LOST', 'The demonstration lease must be recovered by its next owner');
      const index = (cursor + offset) % runs.length, run = runs[index];
      try { const result = { ...run, ...await runner.run(run.domain, run.runId, store) }; results.push(result); console.log(JSON.stringify(result)); }
      catch (error) {
        if (error instanceof ProtocolError && error.code === 'LEASE_LOST') throw error;
        const result = { ...run, stage: 'needs-inspection', complete: false, reason: error instanceof ProtocolError ? error.code : 'LIVE_RUN_STOPPED' };
        results.push(result); console.error(JSON.stringify(result)); process.exitCode = 1;
      }
      await store.setCursor((index + 1) % runs.length);
    }
    const evidence = await store.exportEvidence();
    for (const item of evidence) await immutableJson(join('artifacts', item.kind === 'consensus' ? 'consensus' : 'live', item.value.domain, `${item.value.runId}.json`), item.value);
    const recoveryArtifacts = evidence.filter(item => item.kind === 'recovery').length;
    await atomicJson('artifacts/demo-status.json', { mode: 'live', taskGeneration: 'deterministic', checkedAt: new Date().toISOString(), recoveryArtifacts, results });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `recovery_ready=${recoveryArtifacts === runs.length}\n`);
  } finally { if (timer) clearInterval(timer); await store.release(); await client.close(); }
}
void main().catch(error => { console.error(JSON.stringify({ action: 'scheduled-demonstrations', status: 'UNMET', reason: error instanceof ProtocolError ? error.code : 'DEMO_RUNNER_STOPPED' })); process.exitCode = 1; });
