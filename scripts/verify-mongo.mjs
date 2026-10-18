import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

// Only the explicit test URI is accepted. Never fall back to the application database.
let uri = process.env.MONGODB_TEST_URI;
let databaseReady = Boolean(uri);
let container;
function docker(args, { allowFailure = false, timeout = 120000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`Docker ${args[0]} failed. Allow local Docker access or set MONGODB_TEST_URI to a disposable replica set.`);
  }
  return result;
}
function cleanup() {
  if (!container) return;
  const inspect = docker(['container', 'inspect', container], { allowFailure: true, timeout: 15000 });
  if (inspect.status !== 0 && /no such (object|container)/i.test(inspect.stderr ?? '')) {
    container = undefined;
    return;
  }
  docker(['rm', '--force', container], { timeout: 15000 });
  container = undefined;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    try { cleanup(); } finally { process.exit(1); }
  });
}
async function ready(expression) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = docker(['exec', container, 'mongosh', '--quiet', '--eval', expression], { allowFailure: true, timeout: 5000 });
    if (!result.error && result.status === 0) return;
    const state = docker(['inspect', '--format', '{{.State.Running}}', container], { allowFailure: true, timeout: 5000 });
    if (state.stdout?.trim() === 'false') throw new Error('Disposable MongoDB exited during startup');
    await setTimeout(500);
  }
  throw new Error('Disposable MongoDB did not become ready');
}

try {
  if (!uri) {
    docker(['info', '--format', '{{.ServerVersion}}']);
    const name = `faultline-check-${randomUUID()}`;
    container = name;
    // No persistent volume, public network binding, or existing container is used.
    console.log('Starting disposable mongo:7; the image is downloaded if needed');
    const start = docker(['run', '--detach', '--name', name,
      '--publish', '127.0.0.1::27017', '--memory', '1g', '--cpus', '1',
      '--tmpfs', '/data/db:rw,size=512m', '--tmpfs', '/data/configdb:rw,size=32m',
      'mongo:7', '--replSet', 'rs0', '--bind_ip_all'], { allowFailure: true, timeout: 180000 });
    if (start.error || start.status !== 0) throw new Error('Could not start disposable mongo:7. Check Docker access and image availability.');
    await ready('if (db.adminCommand({ping:1}).ok !== 1) quit(1)');
    docker(['exec', container, 'mongosh', '--quiet', '--eval', 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})']);
    await ready('if (!db.hello().isWritablePrimary) quit(1)');
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(docker(['port', container, '27017/tcp']).stdout)?.[1];
    if (!port) throw new Error('Disposable MongoDB did not expose a loopback port');
    uri = `mongodb://127.0.0.1:${port}/?replicaSet=rs0&directConnection=true`;
    databaseReady = true;
    console.log('Verifying MongoDB against a disposable local replica set');
  }
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/integration/mongo.test.ts', 'tests/integration/mongo-demonstrations.test.ts'], {
    stdio: 'inherit', env: { ...process.env, MONGODB_TEST_URI: uri }, timeout: 90000,
  });
  if (result.error || result.status !== 0) throw new Error('MongoDB integration verification failed');
  cleanup();
  console.log('MONGO:PASS');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MongoDB verification failed');
  if (container && !databaseReady) {
    const logs = docker(['logs', '--tail', '12', container], { allowFailure: true, timeout: 5000 });
    if (logs.status === 0) console.error((logs.stdout + logs.stderr).slice(-6000));
  }
  process.exitCode = 1;
} finally {
  try { cleanup(); } catch {
    console.error(`Stop the disposable verification container ${container}; cleanup failed.`);
    process.exitCode = 1;
  }
}
