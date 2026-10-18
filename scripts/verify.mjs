import { spawnSync } from 'node:child_process';

const name = process.argv[2];
const vitest = (...paths) => [process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...paths]];
const types = [process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']];
const commands = {
  protocol: [vitest('packages/protocol/test')],
  genlayer: [['bash', ['contracts/genlayer/verify.sh']]],
  escrow: [['bash', ['contracts/base/verify.sh']]],
  service: [vitest('packages/service/test')],
  worker: [vitest('apps/worker/test')],
  integrations: [vitest('packages/sdk/test', 'packages/mcp/test', 'packages/a2a/test')],
  ui: [['npm', ['run', 'build', '--workspace', '@faultline/web']]],
  examples: [vitest('examples/test')],
  settlement: [vitest('packages/chain/test', 'packages/service/test', 'apps/worker/test')],
  integration: [types, vitest('tests/integration')],
  'release-controls': [vitest('tests/integration/release.test.ts', 'tests/integration/deployment.test.ts', 'examples/test/artifacts.test.ts')],
  types: [types],
  tests: [vitest()],
  mongo: [[process.execPath, ['scripts/verify-mongo.mjs']]],
  dependencies: [['npm', ['audit', '--audit-level=low']]],
  web: [[process.execPath, ['node_modules/@playwright/test/cli.js', 'test']]],
  consensus: [[process.execPath, ['--import', 'tsx', 'scripts/verify-live.ts', 'consensus']]],
  'live-demos': [[process.execPath, ['--import', 'tsx', 'scripts/verify-live.ts', 'demos']]],
  release: [[process.execPath, ['--import', 'tsx', 'scripts/verify-live.ts', 'release']]],
};

if (!commands[name]) {
  console.error(`Unknown verification gate: ${name}`);
  process.exit(2);
}
for (const [command, args] of commands[name]) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`FAULTLINE:${name}:PASS`);
