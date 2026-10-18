import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { erc20Abi } from 'viem';
import { FaultlineClient, bondApproval } from '@faultline/sdk';
import { LiveChainGateway, type ChainConfig } from '@faultline/chain';
import { USDC_ADDRESS, hashCanonical, hashText } from '@faultline/protocol';
import { DurableSigner } from '@faultline/worker';
import type { SigningJournal } from '../../apps/worker/src/signer';
import { initialState, runTick, type RunState } from './live';
import type { Domain } from './scenarios';
import type { TaskOutput, TaskRequest } from './tasks';
import { artifact } from './artifacts';
import { verifyAudit } from './verify';

export type EvidenceKind = 'consensus' | 'recovery';
export type RunEvidence = ReturnType<typeof artifact>;
export interface ExampleStorage {
  journal: SigningJournal;
  load(initial: RunState): Promise<RunState>;
  save(state: RunState): Promise<void>;
  beforeSigning(): Promise<void>;
  readEvidence(kind: EvidenceKind, state: RunState): Promise<RunEvidence | null>;
  publishEvidence(kind: EvidenceKind, state: RunState, value: RunEvidence): Promise<void>;
}

function task(input: TaskRequest): Promise<TaskOutput> {
  const module = fileURLToPath(new URL('./task-cli.ts', import.meta.url));
  // The child receives neither database nor signing credentials.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', module], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
    let output = '';
    child.on('error', reject);
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 100_000) child.kill(); });
    child.stderr.resume();
    child.on('exit', code => { if (code !== 0) return reject(new Error('Deterministic task process failed')); try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Caller-owned clients and signers. The storage boundary makes every signature restart-safe. */
export function exampleRunner(config: ChainConfig, gateway: LiveChainGateway, env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`${name} is required`); return value; };
  const accounts = ['A', 'B', 'C'].map(name => privateKeyToAccount(required(`DEMO_AGENT_${name}_PRIVATE_KEY`) as `0x${string}`));
  const repairer = privateKeyToAccount(required('DEMO_REPAIRER_PRIVATE_KEY') as `0x${string}`);
  const actors = { creator: accounts[0].address.toLowerCase(), agents: accounts.map(account => account.address.toLowerCase()) as [string, string, string], repairer: repairer.address.toLowerCase() };
  const clients = new Map<string, FaultlineClient>();
  const client = async (actor: string) => {
    const existing = clients.get(actor); if (existing) return existing;
    const account = [...accounts, repairer].find(account => account.address.toLowerCase() === actor);
    if (!account) throw new Error('No caller-owned signer for this actor');
    const value = new FaultlineClient({ baseUrl: required('FAULTLINE_API_URL') });
    await value.authenticate(actor, message => account.signMessage({ message })); clients.set(actor, value); return value;
  };
  return {
    actors,
    initial: (domain: Domain, runId: string) => initialState(domain, actors, runId),
    async run(domain: Domain, runId: string, storage: ExampleStorage) {
      const initial = initialState(domain, actors, runId), state = await storage.load(initial);
      if (state.schemaVersion !== 2 || hashCanonical(initial.manifest) !== hashCanonical(state.manifest)) throw new Error('Run version, identities or immutable terms changed');
      const signers = new Map([...accounts, repairer].map(account => [account.address.toLowerCase(), new DurableSigner(config, account, storage.journal, { spender: config.escrowAddress, amount: '12000000' })]));
      const result = await runTick({
        state, save: () => storage.save(state), client, evidenceOrigin: config.evidenceOrigin, task,
        recordAdjudication: async audit => { await storage.publishEvidence('consensus', state, artifact(state, audit, 'consensus')); },
        sign: async (actor, operation) => { await storage.beforeSigning(); return signers.get(actor)!.submit(operation.id, operation.intent!); },
        fundApproval: async (actor, amount) => {
          const allowance = await gateway.base.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance', args: [actor as `0x${string}`, config.escrowAddress], blockTag: 'finalized' });
          if (allowance >= BigInt(amount)) return true;
          await storage.beforeSigning();
          const hash = await signers.get(actor)!.submit(hashText(`approve:${state.manifest.id}:${actor}`), bondApproval(config.escrowAddress, amount));
          if (!hash) return false;
          let receipt; try { receipt = await gateway.base.getTransactionReceipt({ hash: hash as `0x${string}` }); } catch { return false; }
          if (receipt.status !== 'success') throw new Error('USDC approval reverted');
          const block = await gateway.base.getBlock({ blockTag: 'finalized' });
          return block.number >= receipt.blockNumber && (await gateway.base.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash;
        },
        verifyAudit: async audit => {
          const existing = await storage.readEvidence('recovery', state), candidate = artifact(state, audit, 'recovery');
          if (existing && (hashCanonical(existing.agentRuns) !== hashCanonical(candidate.agentRuns) || hashCanonical(existing.audit.workflow.manifest) !== hashCanonical(state.manifest))) throw new Error('Immutable recovery evidence conflicts with the run');
          const verification = await verifyAudit(existing?.audit ?? audit, gateway);
          if (!existing) await storage.publishEvidence('recovery', state, candidate);
          return verification;
        },
      });
      return { workflowId: state.manifest.id, ...result };
    },
  };
}
