import { spawnSync } from 'node:child_process';

function git(args: string[]) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 10_000_000 });
  // A child-process error can retain the blob in its output fields; never dump it.
  if (result.error || result.status !== 0) throw new Error('Git inspection failed; staged file content was not logged');
  return result.stdout;
}

// Compare staged blobs against actual configured secrets without printing their values.
const secrets = new Set<string>();
const publicRpc = new Set(['https://rpc-bradbury.genlayer.com', 'https://rpc.testnet-chain.genlayer.com', 'https://sepolia.base.org']);
for (const [name, value] of Object.entries(process.env)) {
  if (!value || value.length < 8 || !/PRIVATE_KEY|PASSWORD|TOKEN|SECRET|MONGODB_URI|RPC_URL/.test(name) || publicRpc.has(value)) continue;
  secrets.add(value); secrets.add(encodeURIComponent(value));
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) secrets.add(value.slice(2));
  try { const url = new URL(value); if (url.password.length >= 8) { secrets.add(url.password); secrets.add(decodeURIComponent(url.password)); } } catch { /* Most secrets are not URLs. */ }
}
if (secrets.size < 6) throw new Error('Load the protected release environment before scanning');
const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z']).split('\0').filter(Boolean);
if (!files.length) throw new Error('Stage the release files before scanning');
const rejected: string[] = [];
for (const path of files) {
  if (/(^|\/)\.env(?!\.example$)|(^|\/)(artifacts|\.unlazy|\.vercel)\/|\.private\.json$/.test(path)) { rejected.push(path); continue; }
  const content = git(['show', `:${path}`]);
  if ([...secrets].some(secret => content.includes(secret))) rejected.push(path);
}
console.log(JSON.stringify({ check: 'staged-release-secrets', files: files.length, passed: rejected.length === 0, ...(rejected.length ? { rejected } : {}) }));
if (rejected.length) process.exitCode = 1;
