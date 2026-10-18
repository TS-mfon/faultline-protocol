import { canonical, hashCanonical, HashSchema, ProtocolError, type TransactionIntent } from '@faultline/protocol';
import type { GenLayerTransaction } from 'genlayer-js/types';

export function requireFinalizedGenLayer(tx: GenLayerTransaction): void {
  if (tx.statusName !== 'FINALIZED') throw new ProtocolError('NOT_FINALIZED', `GenLayer is ${tx.statusName ?? 'unknown'}; native finality is required`);
  if (tx.txExecutionResultName !== 'FINISHED_WITH_RETURN') throw new ProtocolError('EXECUTION_FAILED', 'Finalized GenLayer transaction did not execute successfully');
  if (tx.resultName !== 'AGREE' && tx.resultName !== 'MAJORITY_AGREE' && tx.resultName !== 'SUCCESS') throw new ProtocolError('CONSENSUS_FAILED', 'Finalized transaction has no successful consensus result');
  if (tx.txDataDecoded?.leaderOnly) throw new ProtocolError('LEADER_ONLY', 'Faultline requires validator consensus');
}

/** Preserve bytes and integers consistently across ABI decoding and JSON transaction intents. */
export function jsonValue(value: unknown): any {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k,v]) => [k,jsonValue(v)]));
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,jsonValue(v)]));
  return value;
}
export function matchCall(tx: GenLayerTransaction, intent: TransactionIntent): { actor: string; workflowId: string; argsHash: string } {
  const decoded = tx.txDataDecoded;
  if (!decoded || decoded.type !== 'call' || !('callData' in decoded)) throw new ProtocolError('CALLDATA_MISSING', 'Transaction has no decoded contract call');
  const data = jsonValue(decoded.callData);
  if (String(tx.recipient ?? tx.to_address).toLowerCase() !== intent.to.toLowerCase() || data.method !== intent.functionName || canonical(data.args ?? []) !== canonical(jsonValue(intent.args))) throw new ProtocolError('WRONG_TRANSACTION', 'Receipt does not match the intended contract, method and arguments');
  if (data.kwargs && Object.keys(data.kwargs).length) throw new ProtocolError('WRONG_TRANSACTION', 'Unexpected keyword arguments');
  let id = data.args?.[0];
  if (intent.functionName === 'register_workflow') id = JSON.parse(id).id;
  if (intent.functionName === 'record_handoff') id = JSON.parse(id).workflowId;
  return { actor: String(tx.sender ?? tx.from_address).toLowerCase(), workflowId: HashSchema.parse(id), argsHash: hashCanonical(jsonValue(data.args ?? [])) };
}
