import { readFile, open, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { abi as genAbi } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { createPublicClient, createWalletClient, decodeFunctionData, encodeFunctionData, http, keccak256, parseTransaction, recoverTransactionAddress, zeroAddress, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonical, hashCanonical, hashText, ProtocolError } from '@faultline/protocol';
import { atomicJson, immutableJson } from '../examples/src/journal';
import type { SignedRecord } from '../apps/worker/src/signer';

// Explicit operator recovery for an RPC-rejected envelope. Never invoked by a retry loop.
// Re-envelope the same call, or explicitly replace the rejected readable source with
// its mechanically equivalent compact build. The nonce stays fixed in either mode.
async function main() {
  const expectedHash = process.argv[2];
  if (!/^0x[0-9a-f]{64}$/.test(expectedHash ?? '')) throw new ProtocolError('USAGE', 'Supply the inspected rejected submission hash');
  const compact = process.argv[3] === '--compact-source';
  const bundle = process.argv[3] === '--bundled-source';
  const rebuild = compact || bundle;
  if (process.argv[3] && !rebuild) throw new ProtocolError('USAGE', 'Unknown recovery mode');
  if (rebuild) {
    let python = process.env.FAULTLINE_PYTHON ?? 'python3';
    if (!process.env.FAULTLINE_PYTHON && spawnSync(python, ['-c', 'import sys; assert sys.version_info[:2] == (3, 12)']).status !== 0) {
      const found = spawnSync('uv', ['python', 'find', '--offline', '3.12'], { encoding: 'utf8' });
      if (found.status !== 0) throw new ProtocolError('PYTHON_REQUIRED', 'Python 3.12 is required');
      python = found.stdout.trim();
    }
    const verified = spawnSync(python, ['contracts/genlayer/build.py', '--check'], { encoding: 'utf8' });
    if (verified.status !== 0) throw new ProtocolError('SOURCE_NOT_VERIFIED', 'Verify the compact source with Python 3.12 before preparing it');
  }
  const dir = 'artifacts/deployment', lock = await open(`${dir}/deploy.lock`, 'wx', 0o600);
  try {
    const path = `${dir}/signed-transactions.private.json`;
    const records = JSON.parse(await readFile(path, 'utf8')) as Record<string, SignedRecord>;
    const old = records['deployment:genlayer'];
    if (!old || old.evmHash !== expectedHash || keccak256(old.raw) !== expectedHash || old.logicalHash) throw new ProtocolError('JOURNAL_MISMATCH', 'Preserve the existing journal');
    const tx = parseTransaction(old.raw), chain = testnetBradbury;
    if ((!rebuild && tx.type !== 'eip1559') || !['eip1559', 'legacy'].includes(tx.type ?? '') || tx.chainId !== chain.id || tx.nonce !== old.nonce) throw new ProtocolError('NOT_RECOVERABLE', 'Only the inspected rejected envelope is eligible');
    const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
    const transport = http(process.env.GENLAYER_EVM_RPC_URL ?? process.env.GENLAYER_RPC_URL!, { timeout: 20000, retryCount: 0 });
    const pub = createPublicClient({ chain, transport }), wallet = createWalletClient({ chain, transport, account });
    const consensus = chain.consensusMainContract!;
    if (await pub.getChainId() !== chain.id || old.from !== account.address.toLowerCase() || (await recoverTransactionAddress({ serializedTransaction: old.raw as TransactionSerialized })).toLowerCase() !== old.from || tx.to?.toLowerCase() !== consensus.address.toLowerCase() || (tx.value ?? 0n) !== 0n) throw new ProtocolError('WRONG_CHAIN', 'Deployment identity mismatch');
    const source = await readFile(bundle ? 'contracts/genlayer/faultline.deploy.py' : 'contracts/genlayer/faultline.py', 'utf8');
    const args = [`${process.env.PUBLIC_ORIGIN}/api/v1/evidence`, process.env.ATTESTOR_ADDRESS!];
    const expectedIntent = { chain: 'genlayer', chainId: chain.id, to: consensus.address, functionName: 'deploy', args: [hashText(source), ...args], value: '0' };
    const data = genAbi.transactions.serialize([new TextEncoder().encode(source), genAbi.calldata.encode(genAbi.calldata.makeCalldataObject(undefined, args, undefined)), false]);
    const decoded = decodeFunctionData({ abi: consensus.abi, data: tx.data! });
    const fields = decoded.args as any[];
    if (old.intentHash !== hashCanonical(expectedIntent) || decoded.functionName !== 'addTransaction' ||
      String(fields[0]).toLowerCase() !== old.from || fields[1] !== zeroAddress || Number(fields[2]) !== chain.defaultNumberOfInitialValidators ||
      Number(fields[3]) !== chain.defaultConsensusMaxRotations || fields[4] !== data) throw new ProtocolError('INTENT_IMMUTABLE', 'The deployment call cannot change');
    const block = await pub.getBlock();
    if (!rebuild && BigInt(fields[5]) <= block.timestamp + 300n) throw new ProtocolError('SUBMISSION_EXPIRED', 'The original authorization is too close to expiry');
    // Reproduce the precise rejection. Any success, other error or ambiguity stops recovery.
    let rejected = false;
    try { await pub.sendRawTransaction({ serializedTransaction: old.raw }); }
    catch (error: any) { if (error.name === 'InvalidParamsRpcError' && /gas limit too high/i.test(error.details ?? '')) rejected = true; else throw new ProtocolError('AMBIGUOUS_SUBMISSION', 'The original submission cannot be replaced'); }
    if (!rejected) throw new ProtocolError('ORIGINAL_ACCEPTED', 'The original transaction was accepted; inspect its receipt');
    const nonces = await Promise.all(['latest', 'pending'].map(blockTag => pub.getTransactionCount({ address: account.address, blockTag: blockTag as 'latest' | 'pending' })));
    if (nonces.some(n => n !== old.nonce)) throw new ProtocolError('NONCE_CHANGED', 'The original nonce is no longer exclusively available');
    let absent = false;
    try { await pub.getTransaction({ hash: old.evmHash }); }
    catch (error: any) { if (error.name === 'TransactionNotFoundError') absent = true; else throw error; }
    if (!absent) throw new ProtocolError('ORIGINAL_PRESENT', 'The original transaction exists on the network');
    let replacementData = tx.data!, intentHash = old.intentHash;
    if (rebuild) {
      const deployed = await readFile(bundle ? 'contracts/genlayer/faultline.bundle.py' : 'contracts/genlayer/faultline.deploy.py', 'utf8');
      if (Buffer.byteLength(deployed) >= Buffer.byteLength(source)) throw new ProtocolError('SOURCE_NOT_SMALLER', 'The recovery must reduce deployment size');
      const payload = genAbi.transactions.serialize([new TextEncoder().encode(deployed), genAbi.calldata.encode(genAbi.calldata.makeCalldataObject(undefined, args, undefined)), false]);
      const latest = await pub.getBlock();
      replacementData = encodeFunctionData({ abi: consensus.abi, functionName: 'addTransaction', args: [...fields.slice(0, 4), payload, latest.timestamp + 3600n] as any });
      intentHash = hashCanonical({ ...expectedIntent, args: [hashText(deployed), ...args] });
    }
    const request = await wallet.prepareTransactionRequest({ account, chain, type: 'legacy', nonce: old.nonce, to: tx.to!, data: replacementData, value: 0n, ...(!rebuild ? { gas: tx.gas } : {}) });
    const raw = await account.signTransaction(request as any);
    const replacement = { ...old, intentHash, raw, evmHash: keccak256(raw), supersedes: old.evmHash };
    // Archive before changing the current pointer; a crash cannot lose the original bytes.
    await immutableJson(`${dir}/rejected-${old.evmHash}.private.json`, { reason: 'RPC_GAS_LIMIT_TOO_HIGH', record: old });
    records[old._id] = replacement;
    await atomicJson(path, records);
    console.log(canonical({ prepared: true, nonce: old.nonce, original: old.evmHash, replacement: replacement.evmHash, type: 'legacy', compact, bundle, gas: String(request.gas), broadcast: false }));
  } finally { await lock.close(); await unlink(`${dir}/deploy.lock`); }
}
void main().catch(error => { console.error(JSON.stringify({ action: 'recover-genlayer-submission', status: 'UNMET', reason: error instanceof ProtocolError ? error.code : 'RECOVERY_STOPPED' })); process.exitCode = 1; });
