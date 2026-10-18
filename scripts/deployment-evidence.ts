import { decodeFunctionData, encodeDeployData, parseEventLogs, zeroAddress, type Hex } from 'viem';
import { testnetBradbury } from 'genlayer-js/chains';
import { abi as genAbi } from 'genlayer-js';
import type { Hash as GenHash } from 'genlayer-js/types';
import { AddressSchema, HashSchema, USDC_ADDRESS, canonical, hashText, ProtocolError } from '@faultline/protocol';
import { jsonValue, requireFinalizedGenLayer, type LiveChainGateway } from '@faultline/chain';

function requireProof(condition: unknown, code: string): asserts condition { if (!condition) throw new ProtocolError(code, 'Deployment transaction evidence does not match the approved build and identities'); }
export interface DeploymentTransactions {
  deployer: string;
  guardian: string;
  baseTransactionHash: string;
  genlayerTransactionHash: string;
  genlayerSubmissionHash: string;
}
/** Bind code identity to actual creation transactions, their constructors, and successful native finality. */
export async function verifyDeploymentTransactions(gateway: LiveChainGateway, transactions: DeploymentTransactions, build: any, source: string) {
  const { config, base, genEvm, genlayer } = gateway;
  const deployer = AddressSchema.parse(transactions.deployer), guardian = AddressSchema.parse(transactions.guardian);
  const baseHash = HashSchema.parse(transactions.baseTransactionHash) as Hex;
  const genHash = HashSchema.parse(transactions.genlayerTransactionHash) as GenHash;
  const submissionHash = HashSchema.parse(transactions.genlayerSubmissionHash) as Hex;
  const [baseTx, baseReceipt, baseFinalized, genTx, outer, outerReceipt] = await Promise.all([
    base.getTransaction({ hash: baseHash }), base.getTransactionReceipt({ hash: baseHash }), base.getBlock({ blockTag: 'finalized' }),
    genlayer.getTransaction({ hash: genHash }), genEvm.getTransaction({ hash: submissionHash }), genEvm.getTransactionReceipt({ hash: submissionHash }),
  ]);
  requireProof(baseReceipt.status === 'success' && baseFinalized.number >= baseReceipt.blockNumber, 'BASE_DEPLOYMENT_NOT_FINALIZED');
  const baseBlock = await base.getBlock({ blockNumber: baseReceipt.blockNumber });
  requireProof(baseBlock.hash === baseReceipt.blockHash && !baseTx.to && baseReceipt.contractAddress?.toLowerCase() === config.escrowAddress && baseTx.from.toLowerCase() === deployer && baseTx.value === 0n, 'BASE_DEPLOYMENT_BINDING');
  const constructorArgs = [USDC_ADDRESS, config.attestor, guardian];
  const expected = encodeDeployData({ abi: build.abi, bytecode: `0x${build.bytecode.object.replace(/^0x/, '')}`, args: constructorArgs });
  requireProof(baseTx.input.toLowerCase() === expected.toLowerCase(), 'BASE_CREATION_CODE_MISMATCH');
  requireFinalizedGenLayer(genTx);
  const decoded = genTx.txDataDecoded;
  requireProof(decoded?.type === 'deploy' && 'code' in decoded && 'constructorArgs' in decoded && 'contractAddress' in decoded, 'GENLAYER_DEPLOYMENT_DATA_MISSING');
  requireProof(decoded.contractAddress?.toLowerCase() === config.genlayerAddress && String(genTx.sender ?? genTx.from_address).toLowerCase() === deployer && decoded.code === source && hashText(source) === config.genlayerCodeHash, 'GENLAYER_DEPLOYMENT_BINDING');
  const args = jsonValue(decoded.constructorArgs);
  requireProof(canonical(args?.args) === canonical([config.evidenceOrigin, config.attestor]) && (!args?.kwargs || Object.keys(args.kwargs).length === 0), 'GENLAYER_CONSTRUCTOR_MISMATCH');
  const consensus = testnetBradbury.consensusMainContract!;
  requireProof(outerReceipt.status === 'success' && outer.to?.toLowerCase() === consensus.address.toLowerCase() && outer.from.toLowerCase() === deployer && outer.value === 0n, 'GENLAYER_SUBMISSION_BINDING');
  const submission = decodeFunctionData({ abi: consensus.abi, data: outer.input });
  const outerArgs = jsonValue(submission.args) as any[];
  const payload = genAbi.transactions.serialize([new TextEncoder().encode(source), genAbi.calldata.encode(genAbi.calldata.makeCalldataObject(undefined, [config.evidenceOrigin, config.attestor], undefined)), false]);
  requireProof(submission.functionName === 'addTransaction' && String(outerArgs[0]).toLowerCase() === deployer && String(outerArgs[1]).toLowerCase() === zeroAddress && Number(outerArgs[2]) === testnetBradbury.defaultNumberOfInitialValidators && Number(outerArgs[3]) === testnetBradbury.defaultConsensusMaxRotations && outerArgs[4] === payload, 'GENLAYER_SUBMISSION_BINDING');
  const events = parseEventLogs({ abi: consensus.abi, logs: outerReceipt.logs.filter(log => log.address.toLowerCase() === consensus.address.toLowerCase()) });
  requireProof(events.some((event: any) => ['NewTransaction', 'CreatedTransaction'].includes(event.eventName) && event.args.txId === genHash), 'GENLAYER_SUBMISSION_ID_MISMATCH');
  const proposalBlockNumber = BigInt(genTx.readStateBlockRange?.proposalBlock ?? 0);
  requireProof(proposalBlockNumber > 0n, 'GENLAYER_DEPLOYMENT_BLOCK_MISSING');
  const [outerBlock, proposalBlock] = await Promise.all([genEvm.getBlock({ blockNumber: outerReceipt.blockNumber }), genEvm.getBlock({ blockNumber: proposalBlockNumber })]);
  requireProof(outerBlock.hash === outerReceipt.blockHash && proposalBlock.hash, 'GENLAYER_DEPLOYMENT_BLOCK_MISMATCH');
  return {
    deployer, guardian,
    base: { transactionHash: baseHash, blockHash: baseReceipt.blockHash, blockNumber: String(baseReceipt.blockNumber), execution: 'success', finality: 'finalized' },
    genlayer: { transactionHash: genHash, submissionHash, submissionBlockHash: outerReceipt.blockHash, submissionBlockNumber: String(outerReceipt.blockNumber), blockHash: proposalBlock.hash, blockNumber: String(proposalBlockNumber), execution: 'success', finality: 'finalized' },
  };
}
