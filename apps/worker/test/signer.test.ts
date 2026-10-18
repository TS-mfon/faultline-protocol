import { expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseTransaction } from 'viem';
import { abi as genAbi } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { hashText, type TransactionIntent } from '@faultline/protocol';
import { DurableSigner, type SignedRecord, type SigningJournal } from '../src/signer';

const mock = vi.hoisted(() => ({ publicClient: {} as any, wallet: {} as any }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => mock.publicClient, createWalletClient: () => mock.wallet }));

it('signs the SDK-compatible Bradbury envelope once and preserves its native transaction identity on resume', async () => {
  const records = new Map<string, SignedRecord>();
  const journal: SigningJournal = {
    get: async id => records.get(id) ?? null, latest: async () => null, latestNonce: async () => -1,
    insert: async record => { records.set(record._id, record); return record; },
    setLogicalHash: async (id, hash) => { records.get(id)!.logicalHash = hash; },
  };
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`), contract = `0x${'44'.repeat(20)}` as const;
  const config = { genlayerRpc: 'https://rpc.invalid', baseRpc: 'https://base.invalid', genlayerAddress: contract, escrowAddress: contract, genlayerCodeHash: hashText('source'), baseCodeHash: hashText('runtime'), evidenceOrigin: 'https://fixture.invalid/evidence', attestor: account.address };
  const consensus = testnetBradbury.consensusMainContract!, id = hashText('operation'), logicalHash = hashText('native transaction');
  const intent: TransactionIntent = { chain: 'genlayer', chainId: 4221, to: contract, functionName: 'accept_mandate', args: [hashText('workflow')], value: '0' };
  mock.publicClient = {
    getBlock: vi.fn(async () => ({ timestamp: 1000n })), getTransactionCount: vi.fn(async () => 7),
    getTransactionReceipt: vi.fn(async () => { throw new Error('Transaction could not be found'); }),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }) => keccak256(serializedTransaction)),
  };
  mock.wallet = { prepareTransactionRequest: vi.fn(async request => ({ ...request, chainId: request.chain.id, gas: 500_000n, gasPrice: 1n })) };
  const signer = new DurableSigner(config, account, journal);
  expect(await signer.submit(id, intent)).toBeNull();
  const recorded = records.get(id)!;
  const envelope = parseTransaction(recorded.raw);
  expect(envelope).toMatchObject({ type: 'legacy', chainId: 4221, nonce: 7, gasPrice: 1n, to: consensus.address.toLowerCase() });
  const call = decodeFunctionData({ abi: consensus.abi, data: envelope.data! });
  expect(call.functionName).toBe('addTransaction');
  const args = call.args as any[];
  expect(args.slice(0, 4)).toEqual([account.address, contract, BigInt(testnetBradbury.defaultNumberOfInitialValidators), BigInt(testnetBradbury.defaultConsensusMaxRotations)]);
  expect(args[4]).toBe(genAbi.transactions.serialize([genAbi.calldata.encode(genAbi.calldata.makeCalldataObject('accept_mandate', intent.args as any, undefined)), false]));
  expect(args[5]).toBe(4600n);
  mock.publicClient.getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [{ address: consensus.address,
    topics: encodeEventTopics({ abi: consensus.abi, eventName: 'CreatedTransaction', args: { txId: logicalHash } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [1n]) }] });
  expect(await signer.submit(id, intent)).toBe(logicalHash);
  expect(await signer.submit(id, intent)).toBe(logicalHash);
  expect(mock.wallet.prepareTransactionRequest).toHaveBeenCalledTimes(1);
  expect(mock.publicClient.sendRawTransaction).toHaveBeenCalledTimes(1);
  expect(records.get(id)!.raw).toBe(recorded.raw);
  await expect(signer.submit(id, { ...intent, args: [hashText('another workflow')] })).rejects.toMatchObject({ code: 'INTENT_IMMUTABLE' });
});
