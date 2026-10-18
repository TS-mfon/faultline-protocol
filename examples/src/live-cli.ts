import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { LiveChainGateway, chainConfig } from '@faultline/chain';
import { ProtocolError } from '@faultline/protocol';
import { domains, type Domain } from './scenarios';
import type { RunState } from './live';
import { atomicJson, immutableJson, readJson, FileSigningJournal } from './journal';
import { exampleRunner, type EvidenceKind, type RunEvidence } from './runner';

async function main() {
  const domain = process.argv[2] as Domain, runId = process.argv[3];
  if (!domains.includes(domain) || !runId || !/^[\w-]{1,64}$/.test(runId)) throw new ProtocolError('USAGE', 'live <software|research|procurement> <stable-run-id>');
  const directory = resolve('artifacts', 'runs', `${domain}-${runId}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'run.lock'), lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await lock.close();
  try {
    const config = chainConfig(), gateway = await new LiveChainGateway(config).verifyDeployments();
    const statePath = join(directory, 'state.json');
    const evidencePath = (kind: EvidenceKind) => resolve('artifacts', kind === 'consensus' ? 'consensus' : 'live', domain, `${runId}.json`);
    const result = await exampleRunner(config, gateway).run(domain, runId, {
      journal: new FileSigningJournal(join(directory, 'signed-transactions.private.json')),
      load: async initial => await readJson<RunState>(statePath) ?? initial,
      save: state => atomicJson(statePath, state), beforeSigning: async () => {},
      readEvidence: kind => readJson<RunEvidence>(evidencePath(kind)),
      publishEvidence: (kind, _state, value) => immutableJson(evidencePath(kind), value),
    });
    console.log(JSON.stringify(result));
  } finally { await unlink(lockPath); }
}
void main().catch(error => { console.error(JSON.stringify({ error: error instanceof ProtocolError ? error.code : 'LIVE_RUN_STOPPED', message: 'Inspect the checkpoint and chain receipts before retrying.' })); process.exitCode = 1; });
