import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { atomicJson } from '../examples/src/journal';
import { hashCanonical } from '@faultline/protocol';
import { readEvidence, requireDemonstrationCoverage } from './release-evidence';

async function main() {
  if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '')) throw new Error('A checked-out GitHub commit is required');
  await mkdir('artifacts', { recursive: true });
  await copyFile('docs/deployment.json', 'artifacts/deployment.json');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-live.ts', 'release'], { stdio: 'inherit', timeout: 480_000 });
  if (result.error || result.status !== 0) throw new Error('Live release verification remains unmet');
  const workflowIds = requireDemonstrationCoverage(await readEvidence('artifacts/live'));
  await atomicJson('artifacts/release-verification.json', { schemaVersion: 1, status: 'PASS', checkedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA, deploymentHash: hashCanonical(JSON.parse(await readFile('artifacts/deployment.json', 'utf8'))), workflowIds });
  console.log(JSON.stringify({ releaseVerified: true, recoveries: workflowIds.length }));
}
void main().catch(() => { console.error(JSON.stringify({ action: 'scheduled-release-verification', status: 'UNMET' })); process.exitCode = 1; });
