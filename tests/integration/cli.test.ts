import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('../../', import.meta.url));
function run(script: string, ...args: string[]) {
  const env = { ...process.env };
  // Fail configuration before any network request, regardless of the host setup.
  delete env.PUBLIC_ORIGIN;
  delete env.BASE_RPC_URL;
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd, env, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain(':PASS');
  // A transform/import error is not the expected fail-closed configuration result.
  return JSON.parse(result.stderr.trim());
}

it.each(['consensus', 'demos', 'release'])('the %s CLI starts and fails closed without live configuration', kind => {
  expect(run('scripts/verify-live.ts', kind)).toMatchObject({ gate: kind, status: 'UNMET', reason: 'ProtocolError' });
}, 45_000);

it('deployment capture starts and reports missing configuration without dumping an RPC error', () => {
  expect(run('scripts/capture-deployment.ts')).toEqual({ gate: 'deployment', status: 'UNMET', reason: 'NOT_CONFIGURED' });
}, 45_000);

it('worker startup reports configuration failure through the bounded logger', () => {
  expect(run('apps/worker/src/main.ts')).toEqual({ error: 'NOT_CONFIGURED', message: 'Inspect the durable operation journal; signed payloads are not logged.' });
}, 45_000);
