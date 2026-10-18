import { expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeDeployData, encodeEventTopics, encodeFunctionData, zeroAddress } from 'viem';
import { testnetBradbury } from 'genlayer-js/chains';
import { abi as genAbi } from 'genlayer-js';
import { USDC_ADDRESS, hashText } from '@faultline/protocol';
import { verifyDeploymentTransactions } from '../../scripts/deployment-evidence';

// Independent mocked RPC/transaction inputs; none are public deployment evidence.
function fixture() {
  const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
  const source = 'mock GenLayer source', deployer = address(1), guardian = address(2);
  const config = { escrowAddress: address(40), genlayerAddress: address(41), attestor: address(9), evidenceOrigin: 'https://fixture.invalid/api/v1/evidence', genlayerCodeHash: hashText(source) };
  const build = { abi: [{ type: 'constructor', inputs: ['token', 'attestor', 'guardian'].map(name => ({ name, type: 'address' })), stateMutability: 'nonpayable' }], bytecode: { object: '0x6000' } };
  const transactions = { deployer, guardian, baseTransactionHash: hashText('base create'), genlayerTransactionHash: hashText('native create'), genlayerSubmissionHash: hashText('outer create') };
  const baseHash = hashText('base block'), outerHash = hashText('outer block'), proposalHash = hashText('native proposal block');
  const baseTx = { to: null, from: deployer, value: 0n, input: encodeDeployData({ abi: build.abi, bytecode: '0x6000', args: [USDC_ADDRESS, config.attestor, guardian] }) };
  const baseReceipt = { status: 'success', contractAddress: config.escrowAddress, blockNumber: 30n, blockHash: baseHash };
  const genTx = { statusName: 'FINALIZED', txExecutionResultName: 'FINISHED_WITH_RETURN', resultName: 'AGREE', sender: deployer, readStateBlockRange: { proposalBlock: '20' }, txDataDecoded: { type: 'deploy', code: source, contractAddress: config.genlayerAddress, constructorArgs: { args: [config.evidenceOrigin, config.attestor] }, leaderOnly: false } };
  const consensus = testnetBradbury.consensusMainContract!;
  const payload = genAbi.transactions.serialize([new TextEncoder().encode(source), genAbi.calldata.encode(genAbi.calldata.makeCalldataObject(undefined, [config.evidenceOrigin, config.attestor], undefined)), false]);
  const outer = { to: consensus.address, from: deployer, value: 0n, input: encodeFunctionData({ abi: consensus.abi, functionName: 'addTransaction', args: [deployer, zeroAddress, BigInt(testnetBradbury.defaultNumberOfInitialValidators), BigInt(testnetBradbury.defaultConsensusMaxRotations), payload, 1900000000n] as any }) };
  const log = { address: consensus.address, topics: encodeEventTopics({ abi: consensus.abi, eventName: 'CreatedTransaction', args: { txId: transactions.genlayerTransactionHash } }), data: encodeAbiParameters([{ type: 'uint256' }], [1n]) };
  const outerReceipt = { status: 'success', blockNumber: 10n, blockHash: outerHash, logs: [log] };
  const gateway = { config,
    base: { getTransaction: vi.fn(async () => baseTx), getTransactionReceipt: vi.fn(async () => baseReceipt), getBlock: vi.fn(async () => ({ number: 30n, hash: baseHash })) },
    genlayer: { getTransaction: vi.fn(async () => genTx) },
    genEvm: { getTransaction: vi.fn(async () => outer), getTransactionReceipt: vi.fn(async () => outerReceipt), getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: blockNumber === 10n ? outerHash : proposalHash })) },
  };
  return { gateway, build, source, transactions, baseTx, baseReceipt, genTx, outer, outerReceipt };
}

it('binds both creation transactions, native submission event and constructor arguments', async () => {
  const c = fixture();
  expect(await verifyDeploymentTransactions(c.gateway as any, c.transactions, c.build, c.source)).toMatchObject({ deployer: c.transactions.deployer, base: { transactionHash: c.transactions.baseTransactionHash, finality: 'finalized' }, genlayer: { transactionHash: c.transactions.genlayerTransactionHash, submissionHash: c.transactions.genlayerSubmissionHash, finality: 'finalized' } });
});
it.each(['creation code', 'constructor', 'submission payload', 'native pending', 'native failed', 'sender', 'missing event', 'reorg', 'base pending'])('rejects changed or incomplete %s evidence', async fault => {
  const c = fixture();
  if (fault === 'creation code') c.baseTx.input = '0x6001';
  if (fault === 'constructor') c.genTx.txDataDecoded.constructorArgs.args[0] = 'https://different.invalid/evidence';
  if (fault === 'submission payload') c.outer.input = encodeFunctionData({ abi: testnetBradbury.consensusMainContract!.abi, functionName: 'addTransaction', args: [c.transactions.deployer, zeroAddress, BigInt(testnetBradbury.defaultNumberOfInitialValidators), BigInt(testnetBradbury.defaultConsensusMaxRotations), '0xc0', 1900000000n] as any });
  if (fault === 'native pending') c.genTx.statusName = 'ACCEPTED';
  if (fault === 'native failed') c.genTx.txExecutionResultName = 'FINISHED_WITH_ERROR';
  if (fault === 'sender') c.genTx.sender = c.gateway.config.attestor;
  if (fault === 'missing event') c.outerReceipt.logs = [];
  if (fault === 'reorg') c.baseReceipt.blockHash = hashText('noncanonical block');
  if (fault === 'base pending') c.gateway.base.getBlock.mockResolvedValue({ number: 29n, hash: c.baseReceipt.blockHash });
  await expect(verifyDeploymentTransactions(c.gateway as any, c.transactions, c.build, c.source)).rejects.toThrow();
});
