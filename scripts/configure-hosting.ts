import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { ProtocolError } from '@faultline/protocol';

const required = (name: string) => { const value = process.env[name]; if (!value) throw new ProtocolError('NOT_CONFIGURED', `${name} is required`); return value; };
let stage = 'configuration';
function command(executable: string, args: string[], input?: string) {
  // Values travel over stdin, never shell interpolation or process arguments.
  const result = spawnSync(executable, args, { input, encoding: 'utf8', timeout: 60000, maxBuffer: 2_000_000 });
  if (result.error || result.status !== 0) throw new ProtocolError('HOSTING_COMMAND_FAILED', 'Inspect the named hosting configuration stage');
  return result.stdout;
}

async function main() {
  const mode = process.argv[2];
  const deployment = JSON.parse(await readFile('artifacts/deployment.json', 'utf8'));
  if (deployment.base.finality !== 'finalized' || deployment.genlayer.finality !== 'finalized' || deployment.base.address !== required('BASE_ESCROW_ADDRESS') || deployment.genlayer.address !== required('GENLAYER_CONTRACT_ADDRESS') || deployment.base.codeHash !== required('BASE_CODE_HASH') || deployment.genlayer.codeHash !== required('GENLAYER_CODE_HASH')) throw new ProtocolError('DEPLOYMENT_REQUIRED', 'Hosting configuration must match the verified deployments');
  const shared = ['MONGODB_DATABASE', 'PUBLIC_ORIGIN', 'GENLAYER_CONTRACT_ADDRESS', 'BASE_ESCROW_ADDRESS', 'GENLAYER_CODE_HASH', 'BASE_CODE_HASH', 'ATTESTOR_ADDRESS'];
  const rpc = ['GENLAYER_RPC_URL', 'BASE_RPC_URL', ...(process.env.GENLAYER_EVM_RPC_URL ? ['GENLAYER_EVM_RPC_URL'] : [])];
  if (mode === 'web') {
    const project = JSON.parse(await readFile('.vercel/project.json', 'utf8'));
    for (const name of [...shared, ...rpc, 'MONGODB_URI', 'AUTH_SECRET']) {
      stage = `web:${name}`;
      command('vercel', ['env', 'add', name, 'production', '--project', project.projectId, '--force', '--sensitive', '--yes'], required(name));
      console.log(JSON.stringify({ configured: name, destination: 'vercel-production' }));
    }
    return;
  }
  if (mode !== 'github') throw new ProtocolError('USAGE', 'Use web or github');
  const url = new URL(required('PUBLIC_REPOSITORY_URL'));
  if (url.origin !== 'https://github.com' || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) throw new ProtocolError('REPOSITORY', 'A public GitHub repository URL is required');
  const repo = url.pathname.replace(/^\/|\/$/g, ''), environment = `repos/${repo}/environments/testnet`;
  stage = 'github:testnet-environment';
  command('gh', ['api', '--method', 'PUT', environment, '--input', '-'], JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }));
  const policies = JSON.parse(command('gh', ['api', `${environment}/deployment-branch-policies`]));
  if (!policies.branch_policies.some((policy: any) => policy.name === 'main' && policy.type === 'branch')) command('gh', ['api', '--method', 'POST', `${environment}/deployment-branch-policies`, '--input', '-'], JSON.stringify({ name: 'main', type: 'branch' }));
  for (const name of ['MONGODB_URI', ...rpc, 'ATTESTOR_PRIVATE_KEY', 'DEMO_AGENT_A_PRIVATE_KEY', 'DEMO_AGENT_B_PRIVATE_KEY', 'DEMO_AGENT_C_PRIVATE_KEY', 'DEMO_REPAIRER_PRIVATE_KEY']) {
    stage = `github:secret:${name}`;
    command('gh', ['secret', 'set', name, '--repo', repo, '--env', 'testnet'], required(name));
    console.log(JSON.stringify({ configured: name, destination: 'github-testnet-secret' }));
  }
  for (const name of [...shared, 'FAULTLINE_API_URL', 'FAULTLINE_DEMO_RUN_PREFIX', 'PUBLIC_REPOSITORY_URL']) {
    stage = `github:variable:${name}`;
    command('gh', ['variable', 'set', name, '--repo', repo], required(name));
    console.log(JSON.stringify({ configured: name, destination: 'github-variable' }));
  }
  // Enabling schedules is an explicit final step after app/API and funding verification.
  console.log(JSON.stringify({ configured: true, schedulesChanged: false }));
}
void main().catch(error => { console.error(JSON.stringify({ action: 'configure-hosting', status: 'UNMET', stage, reason: error instanceof ProtocolError ? error.code : 'CONFIGURATION_STOPPED' })); process.exitCode = 1; });
