import { mkdir, open, unlink } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { testnetBradbury } from 'genlayer-js/chains';
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, keccak256, parseEventLogs, type Hex } from 'viem';
import { USDC_ADDRESS, hashCanonical, ProtocolError, type TransactionIntent } from '@faultline/protocol';
import { journalOnce } from '../apps/worker/src/signer';
import { atomicJson, immutableJson, readJson, FileSigningJournal } from '../examples/src/journal';

const required = (name: string) => { const value = process.env[name]; if (!value) throw new ProtocolError('NOT_CONFIGURED', `${name} is required`); return value; };
type Transfer = { id: string; role: string; chain: 'base' | 'genlayer'; asset: 'native' | 'USDC'; to: Hex; amount: string };
type Plan = { schemaVersion: 1; deployer: string; targetsHash: string; transfers: Transfer[] };

async function main() {
  const inspect = process.argv[2] === '--inspect';
  if (!inspect && process.argv[2] !== '--fund') throw new ProtocolError('USAGE', 'Use --inspect or --fund; transfers remain fixed after the first plan');
  const account = privateKeyToAccount(required('DEPLOYER_PRIVATE_KEY') as Hex);
  const roles = ['ATTESTOR', 'DEMO_AGENT_A', 'DEMO_AGENT_B', 'DEMO_AGENT_C', 'DEMO_REPAIRER'].map(role => ({ role, address: privateKeyToAccount(required(`${role}_PRIVATE_KEY`) as Hex).address.toLowerCase() as Hex }));
  if (new Set([account.address.toLowerCase(), ...roles.map(role => role.address)]).size !== 6 || roles[0].address !== required('ATTESTOR_ADDRESS')) throw new ProtocolError('IDENTITY_MISMATCH', 'Six distinct authorized testnet identities are required');
  const clients = {
    base: createPublicClient({ chain: baseSepolia, transport: http(required('BASE_RPC_URL'), { timeout: 20000, retryCount: 0 }) }),
    genlayer: createPublicClient({ chain: testnetBradbury, transport: http(process.env.GENLAYER_EVM_RPC_URL ?? required('GENLAYER_RPC_URL'), { timeout: 20000, retryCount: 0 }) }),
  };
  if (await clients.base.getChainId() !== 84532 || await clients.genlayer.getChainId() !== 4221) throw new ProtocolError('WRONG_CHAIN', 'Funding is restricted to Base Sepolia and Bradbury');
  const balances = await Promise.all([{ role: 'DEPLOYER', address: account.address }, ...roles].map(async role => ({
    ...role,
    baseWei: String(await clients.base.getBalance({ address: role.address })),
    genWei: String(await clients.genlayer.getBalance({ address: role.address })),
    usdcBaseUnits: String(await clients.base.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [role.address] })),
  })));
  if (inspect) { console.log(JSON.stringify({ testnetOnly: true, balances, baseGasPrice: String(await clients.base.getGasPrice()), genGasPrice: String(await clients.genlayer.getGasPrice()), broadcast: false })); return; }
  for (const chain of ['base', 'genlayer']) {
    const deployment = await readJson<{ status: string; address: string }>(`artifacts/deployment/${chain}.json`);
    if (deployment?.status !== 'finalized' || deployment.address !== required(chain === 'base' ? 'BASE_ESCROW_ADDRESS' : 'GENLAYER_CONTRACT_ADDRESS')) throw new ProtocolError('DEPLOYMENT_REQUIRED', 'Verify both deployments before funding callers');
  }
  const targets = roles.flatMap(({ role, address }) => [
    { role, chain: 'base' as const, asset: 'native' as const, to: address, amount: role === 'ATTESTOR' ? '8000000000000000' : role === 'DEMO_REPAIRER' ? '1000000000000000' : '2000000000000000' },
    { role, chain: 'genlayer' as const, asset: 'native' as const, to: address, amount: role === 'ATTESTOR' ? '4000000000000000000' : role === 'DEMO_REPAIRER' ? '1000000000000000000' : '2000000000000000000' },
    ...(role.startsWith('DEMO_AGENT_') ? [{ role, chain: 'base' as const, asset: 'USDC' as const, to: address, amount: '108000000' }] : []),
  ]);
  const dir = 'artifacts/funding'; await mkdir(dir, { recursive: true, mode: 0o700 });
  // Deployment and funding share the deployer; the same lock excludes concurrent nonce writers.
  const lockPath = 'artifacts/deployment/deploy.lock', lock = await open(lockPath, 'wx', 0o600);
  try {
    const targetsHash = hashCanonical(targets), path = `${dir}/plan.json`;
    let plan = await readJson<Plan>(path);
    if (!plan) {
      const transfers = targets.map(target => {
        const balance = balances.find(balance => balance.address.toLowerCase() === target.to)!;
        const have = BigInt(target.asset === 'USDC' ? balance.usdcBaseUnits : target.chain === 'base' ? balance.baseWei : balance.genWei);
        return { ...target, id: `funding:${target.chain}:${target.asset}:${target.role}`, amount: String(BigInt(target.amount) > have ? BigInt(target.amount) - have : 0n) };
      }).filter(transfer => transfer.amount !== '0');
      const donor = balances[0];
      const sum = (chain: string, asset: string) => transfers.filter(t => t.chain === chain && t.asset === asset).reduce((total, t) => total + BigInt(t.amount), 0n);
      if (sum('base', 'USDC') > BigInt(donor.usdcBaseUnits) || sum('base', 'native') + 1000000000000000n > BigInt(donor.baseWei) || sum('genlayer', 'native') + 1000000000000000000n > BigInt(donor.genWei)) throw new ProtocolError('INSUFFICIENT_FUNDS', 'Preserve gas reserves; no partial funding plan was signed');
      plan = { schemaVersion: 1, deployer: account.address.toLowerCase(), targetsHash, transfers };
      await immutableJson(path, plan);
    }
    if (plan.deployer !== account.address.toLowerCase() || plan.targetsHash !== targetsHash) throw new ProtocolError('PLAN_IMMUTABLE', 'Funding identities and budgets cannot change');
    if (new Set(plan.transfers.map(t => t.id)).size !== plan.transfers.length || plan.transfers.some(t => {
      const target = targets.find(x => x.role === t.role && x.chain === t.chain && x.asset === t.asset);
      return !target || t.id !== `funding:${t.chain}:${t.asset}:${t.role}` || t.to !== target.to || !/^[1-9][0-9]*$/.test(t.amount) || BigInt(t.amount) > BigInt(target.amount);
    })) throw new ProtocolError('PLAN_INVALID', 'Transfers must match the approved recipients and bounded amounts');
    const journal = new FileSigningJournal(`${dir}/signed-transactions.private.json`), evidence: Record<string, unknown>[] = [];
    for (const transfer of plan.transfers) {
      const chain = transfer.chain === 'base' ? baseSepolia : testnetBradbury, pub = clients[transfer.chain];
      const token = transfer.asset === 'USDC';
      const intent: TransactionIntent = { chain: transfer.chain, chainId: chain.id, to: token ? USDC_ADDRESS : transfer.to, functionName: token ? 'transfer' : 'transferNative', args: token ? [transfer.to, transfer.amount] : [], value: token ? '0' : transfer.amount };
      const signed = await journalOnce(journal, transfer.id, intent, async () => {
        const rpc = transfer.chain === 'base' ? required('BASE_RPC_URL') : process.env.GENLAYER_EVM_RPC_URL ?? required('GENLAYER_RPC_URL');
        const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20000, retryCount: 0 }) });
        const nonce = Math.max(await pub.getTransactionCount({ address: account.address, blockTag: 'pending' }), (await journal.latestNonce(chain.id, account.address.toLowerCase())) + 1);
        const data = token ? encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [transfer.to, BigInt(transfer.amount)] }) : '0x';
        const request = await wallet.prepareTransactionRequest({ account, chain, nonce, to: intent.to as Hex, data, value: BigInt(intent.value!), ...(transfer.chain === 'genlayer' ? { type: 'legacy' as const } : {}) });
        const raw = await account.signTransaction(request as any);
        return { _id: transfer.id, intentHash: hashCanonical(intent), chainId: chain.id, from: account.address.toLowerCase(), nonce, raw, evmHash: keccak256(raw) };
      });
      let receipt;
      try { receipt = await pub.getTransactionReceipt({ hash: signed.evmHash }); }
      catch (error) { if (!/could not be found|not found/i.test(String(error))) throw error; }
      if (!receipt) {
        try { await pub.sendRawTransaction({ serializedTransaction: signed.raw }); }
        catch (error) { if (!/already known|known transaction|nonce too low/i.test(String(error))) throw error; }
        const item = { ...transfer, transactionHash: signed.evmHash, status: 'submitted' }; evidence.push(item); console.log(JSON.stringify(item)); continue;
      }
      if (receipt.status !== 'success') throw new ProtocolError('FUNDING_REVERTED', 'Inspect the original transfer receipt; never re-sign it');
      const [tx, included, finalized] = await Promise.all([pub.getTransaction({ hash: signed.evmHash }), pub.getBlock({ blockNumber: receipt.blockNumber }), pub.getBlock({ blockTag: 'finalized' })]);
      if (included.hash !== receipt.blockHash || tx.from.toLowerCase() !== account.address.toLowerCase() || tx.to?.toLowerCase() !== intent.to.toLowerCase() || tx.value !== BigInt(intent.value!)) throw new ProtocolError('FUNDING_BINDING', 'Funding receipt does not match its signed intent');
      if (token && !parseEventLogs({ abi: erc20Abi, logs: receipt.logs.filter(log => log.address.toLowerCase() === USDC_ADDRESS.toLowerCase()) }).some(event => event.eventName === 'Transfer' && event.args.from.toLowerCase() === account.address.toLowerCase() && event.args.to.toLowerCase() === transfer.to && event.args.value === BigInt(transfer.amount))) throw new ProtocolError('TOKEN_TRANSFER_MISSING', 'Funding needs the exact USDC Transfer event');
      const item = { ...transfer, transactionHash: signed.evmHash, blockHash: receipt.blockHash, blockNumber: String(receipt.blockNumber), status: finalized.number >= receipt.blockNumber ? 'finalized' : 'confirming' };
      evidence.push(item); console.log(JSON.stringify(item));
    }
    await atomicJson(`${dir}/receipts.json`, { schemaVersion: 1, testnetOnly: true, transfers: evidence });
  } finally { await lock.close(); await unlink(lockPath); }
}
void main().catch(error => { console.error(JSON.stringify({ action: 'fund-demo-wallets', status: 'UNMET', reason: error instanceof ProtocolError ? error.code : 'FUNDING_INTERRUPTED' })); process.exitCode = 1; });
