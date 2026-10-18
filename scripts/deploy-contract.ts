import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createClient, abi as genAbi } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import type { Hash as GenHash } from 'genlayer-js/types';
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getContractAddress, http, keccak256, parseEventLogs, parseTransaction, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { AddressSchema, USDC_ADDRESS, hashCanonical, hashText, ProtocolError, type TransactionIntent } from '@faultline/protocol';
import { jsonValue, requireFinalizedGenLayer } from '@faultline/chain';
import { journalOnce } from '../apps/worker/src/signer';
import { atomicJson, FileSigningJournal } from '../examples/src/journal';

const required = (name: string) => { const value = process.env[name]; if (!value) throw new ProtocolError('NOT_CONFIGURED', `${name} is required`); return value; };
let stage = 'configuration';
async function main() {
  const target = process.argv[2];
  if (target !== 'base' && target !== 'genlayer') throw new ProtocolError('USAGE', 'deploy-contract.ts <base|genlayer>');
  const account = privateKeyToAccount(required('DEPLOYER_PRIVATE_KEY') as Hex);
  const attestor = AddressSchema.parse(required('ATTESTOR_ADDRESS')) as Hex;
  const chain = target === 'base' ? baseSepolia : testnetBradbury;
  const rpc = target === 'base' ? required('BASE_RPC_URL') : process.env.GENLAYER_EVM_RPC_URL ?? required('GENLAYER_RPC_URL');
  const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 20000, retryCount: 0 }) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20000, retryCount: 0 }) });
  stage = 'chain-identity';
  if (await pub.getChainId() !== chain.id) throw new ProtocolError('WRONG_CHAIN', 'Deployment is restricted to the configured testnet');
  if (process.argv[3] === '--inspect') {
    stage = 'inspect-journal';
    const signed = await new FileSigningJournal('artifacts/deployment/signed-transactions.private.json').get(`deployment:${target}`);
    if (!signed) throw new ProtocolError('NOT_FOUND', 'No deployment has been signed');
    const transaction = parseTransaction(signed.raw);
    const [block, pendingNonce, latestNonce] = await Promise.all([pub.getBlock(), pub.getTransactionCount({ address: account.address, blockTag: 'pending' }), pub.getTransactionCount({ address: account.address, blockTag: 'latest' })]);
    let found = false;
    try { await pub.getTransaction({ hash: signed.evmHash }); found = true; }
    catch (error) { if (!/could not be found|not found/i.test(String(error))) throw error; }
    console.log(JSON.stringify({ chain: target, submissionHash: signed.evmHash, nonce: signed.nonce, pendingNonce, latestNonce, found, gas: String(transaction.gas), blockGasLimit: String(block.gasLimit), dataBytes: ((transaction.data?.length ?? 2) - 2) / 2 }));
    if (!found && target === 'genlayer') {
      stage = 'simulate-within-block-gas-limit';
      const gas = await pub.estimateGas({ account, to: transaction.to, data: transaction.data, value: transaction.value, gas: block.gasLimit, type: 'legacy' });
      console.log(JSON.stringify({ estimatedLegacyGas: String(gas) }));
      if (process.argv.includes('--gas-probes')) for (const limit of [30_000_000n, 16_000_000n]) {
        try { await pub.call({ account, to: transaction.to, data: transaction.data, value: 0n, gas: limit }); console.log(JSON.stringify({ simulatedGasLimit: String(limit), success: true })); }
        catch (error: any) { console.log(JSON.stringify({ simulatedGasLimit: String(limit), success: false, errorName: error.name, summary: String(error.shortMessage ?? '').split('\n')[0].replace(/0x[0-9a-fA-F]{64,}/g, '[transaction]').slice(0, 160) })); }
      }
    }
    return;
  }
  let code: string, args: string[], data: Hex, to: Hex | undefined;
  if (target === 'base') {
    const build = JSON.parse(await readFile('contracts/base/out/FaultlineBondEscrow.sol/FaultlineBondEscrow.json', 'utf8'));
    code = build.bytecode.object;
    args = [USDC_ADDRESS, attestor, AddressSchema.parse(required('GUARDIAN_ADDRESS'))];
    data = encodeDeployData({ abi: build.abi, bytecode: `0x${code.replace(/^0x/, '')}`, args });
  } else {
    const origin = new URL(required('PUBLIC_ORIGIN'));
    if (origin.protocol !== 'https:' || origin.origin !== required('PUBLIC_ORIGIN')) throw new ProtocolError('PUBLIC_ORIGIN', 'A final public HTTPS origin is required');
    code = await readFile('contracts/genlayer/faultline.bundle.py', 'utf8');
    if (process.argv[3] === '--schema') {
      stage = 'verify-native-bundle-schema';
      const gen = createClient({ chain: testnetBradbury, endpoint: required('GENLAYER_RPC_URL') });
      const schemas = await Promise.all([gen.getContractSchemaForCode(code), gen.getContractSchemaForCode(await readFile('contracts/genlayer/faultline.py', 'utf8'))]);
      if (hashCanonical(schemas[0]) !== hashCanonical(schemas[1])) throw new ProtocolError('BUNDLE_SCHEMA_MISMATCH', 'The native runtime must expose the exact original schema');
      console.log(JSON.stringify({ target, bundledBytes: Buffer.byteLength(code), schemaMatchesOriginal: true, schema: schemas[0], broadcast: false })); return;
    }
    args = [`${origin.origin}/api/v1/evidence`, attestor];
    const consensus = testnetBradbury.consensusMainContract!;
    const serialized = genAbi.transactions.serialize([new TextEncoder().encode(code), genAbi.calldata.encode(genAbi.calldata.makeCalldataObject(undefined, args, undefined)), false]);
    const block = await pub.getBlock(); to = consensus.address;
    data = encodeFunctionData({ abi: consensus.abi, functionName: 'addTransaction', args: [account.address, zeroAddress, BigInt(testnetBradbury.defaultNumberOfInitialValidators), BigInt(testnetBradbury.defaultConsensusMaxRotations), serialized, block.timestamp + 3600n] as any });
  }
  if (process.argv[3] === '--estimate') {
    stage = 'estimate-deployment';
    const gas = await pub.estimateGas({ account, ...(to ? { to } : {}), data, value: 0n, ...(target === 'genlayer' ? { type: 'legacy' as const } : {}) });
    console.log(JSON.stringify({ target, sourceBytes: Buffer.byteLength(code), estimatedGas: String(gas), broadcast: false })); return;
  }
  const intent: TransactionIntent = { chain: target, chainId: chain.id, to: to ?? zeroAddress, functionName: 'deploy', args: [hashText(code), ...args], value: '0' };
  const directory = 'artifacts/deployment'; await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${directory}/deploy.lock`, lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, target, createdAt: new Date().toISOString() })); await lock.close();
  try {
    const journal = new FileSigningJournal(`${directory}/signed-transactions.private.json`);
    stage = 'prepare-transaction';
    const signed = await journalOnce(journal, `deployment:${target}`, intent, async () => {
      const nonce = Math.max(await pub.getTransactionCount({ address: account.address, blockTag: 'pending' }), (await journal.latestNonce(chain.id, account.address.toLowerCase())) + 1);
      const request = await wallet.prepareTransactionRequest({ account, chain, ...(to ? { to } : {}), data, value: 0n, nonce, ...(target === 'genlayer' ? { type: 'legacy' as const } : {}) });
      const raw = await account.signTransaction(request as any);
      return { _id: `deployment:${target}`, intentHash: hashCanonical(intent), chainId: chain.id, from: account.address.toLowerCase(), nonce, raw, evmHash: keccak256(raw) };
    });
    const record: Record<string, unknown> = { schemaVersion: 1, chain: target, chainId: chain.id, deployer: account.address.toLowerCase(), codeHash: hashText(code), constructorArgs: args, submissionHash: signed.evmHash, status: 'prepared' };
    const save = async () => { await atomicJson(`${directory}/${target}.json`, record); console.log(JSON.stringify(record)); };
    // Publish the known hash before submission, even if transport fails after accepting it.
    await atomicJson(`${directory}/${target}.json`, record);
    stage = 'lookup-journaled-transaction';
    let receipt;
    try { receipt = await pub.getTransactionReceipt({ hash: signed.evmHash }); }
    catch (error) { if (!/could not be found|not found/i.test(String(error))) throw error; }
    if (!receipt) {
      stage = 'submit-journaled-transaction';
      try { await pub.sendRawTransaction({ serializedTransaction: signed.raw }); }
      catch (error) { if (!/already known|known transaction|nonce too low/i.test(String(error))) throw error; }
      record.status = 'submitted'; await save(); return;
    }
    stage = 'verify-receipt';
    if (receipt.status !== 'success') throw new ProtocolError('DEPLOYMENT_REVERTED', 'The journaled deployment reverted; do not re-sign it');
    record.blockHash = receipt.blockHash; record.blockNumber = String(receipt.blockNumber);
    if (target === 'base') {
      const expected = getContractAddress({ from: account.address, nonce: BigInt(signed.nonce) }).toLowerCase();
      if (receipt.contractAddress?.toLowerCase() !== expected) throw new ProtocolError('DEPLOYMENT_ADDRESS', 'Creation address differs from the journal');
      record.address = expected; record.transactionHash = signed.evmHash;
      const [finalized, included] = await Promise.all([pub.getBlock({ blockTag: 'finalized' }), pub.getBlock({ blockNumber: receipt.blockNumber })]);
      if (included.hash !== receipt.blockHash) throw new ProtocolError('REORG', 'Deployment receipt is not canonical');
      record.status = finalized.number >= receipt.blockNumber ? 'finalized' : 'confirming';
    } else {
      const consensus = testnetBradbury.consensusMainContract!;
      const events = parseEventLogs({ abi: consensus.abi, logs: receipt.logs.filter(log => log.address.toLowerCase() === consensus.address.toLowerCase()) });
      const event = events.find((event: any) => ['NewTransaction', 'CreatedTransaction'].includes(event.eventName)) as any;
      if (!event?.args?.txId) throw new ProtocolError('CONSENSUS_EVENT_MISSING', 'Deployment lacks a native transaction ID');
      const hash = event.args.txId as GenHash; await journal.setLogicalHash(`deployment:${target}`, hash); record.transactionHash = hash;
      const gen = createClient({ chain: testnetBradbury, endpoint: required('GENLAYER_RPC_URL') }), tx = await gen.getTransaction({ hash });
      record.status = tx.statusName ?? 'UNKNOWN';
      record.execution = tx.txExecutionResultName ?? 'UNKNOWN';
      record.consensusResult = tx.resultName ?? 'UNKNOWN';
      if (tx.statusName === 'ACCEPTED') {
        const timing = testnetBradbury.consensusDataContract!, block = await pub.getBlock();
        record.observedTimestamp = String(block.timestamp);
        record.nativeFinalization = jsonValue(await pub.readContract({ address: timing.address, abi: timing.abi, functionName: 'canFinalize', args: [hash, block.timestamp], blockNumber: block.number }));
      }
      if (tx.txDataDecoded?.type === 'deploy' && 'contractAddress' in tx.txDataDecoded) record.address = String(tx.txDataDecoded.contractAddress).toLowerCase();
      if (tx.statusName === 'FINALIZED') { requireFinalizedGenLayer(tx); record.status = 'finalized'; }
    }
    await save();
  } finally { await unlink(lockPath); }
}
void main().catch(error => {
  const errorName = typeof error?.name === 'string' && /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error';
  const redact = (value: unknown) => {
    if (typeof value !== 'string') return undefined;
    let text = value.split('\n')[0];
    for (const [name, secret] of Object.entries(process.env)) if (secret && /KEY|SECRET|PASSWORD|URI|RPC_URL/.test(name)) text = text.split(secret).join('[redacted]');
    return text.replace(/https?:\/\/\S+/g, '[RPC]').replace(/0x[0-9a-fA-F]{64,}/g, '[transaction]').slice(0, 240);
  };
  console.error(JSON.stringify({ action: 'deployment', status: 'UNMET', reason: error instanceof ProtocolError ? error.code : 'DEPLOYMENT_INTERRUPTED', stage, errorName, summary: redact(error?.shortMessage), rpcDetail: redact(error?.details), detail: 'Inspect the journaled transaction hash before retrying. No signed bytes are logged.' }));
  process.exitCode = 1;
});
