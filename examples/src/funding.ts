import { erc20Abi, type Hex } from 'viem';
import { BASE_CHAIN_ID, USDC_ADDRESS, hashCanonical, hashText, ProtocolError } from '@faultline/protocol';
import { bondApproval } from '@faultline/sdk';
import type { LiveChainGateway, ChainConfig } from '@faultline/chain';
import type { DurableSigner, SigningJournal } from '../../apps/worker/src/signer';

interface FundingDependencies {
  gateway: LiveChainGateway;
  config: ChainConfig;
  journal: SigningJournal;
  signer: Pick<DurableSigner, 'submit'>;
  beforeSigning(): Promise<void>;
}

async function finalized(base: LiveChainGateway['base'], hash: Hex) {
  let receipt;
  try { receipt = await base.getTransactionReceipt({ hash }); }
  catch (error) { if (!/could not be found|not found/i.test(String(error))) throw error; return false; }
  if (receipt.status !== 'success') throw new ProtocolError('TRANSACTION_REVERTED', 'A journaled Base transaction reverted; inspect it before funding again');
  const [head, included] = await Promise.all([base.getBlock({ blockTag: 'finalized' }), base.getBlock({ blockNumber: receipt.blockNumber })]);
  return head.number >= receipt.blockNumber && included.hash === receipt.blockHash;
}

/** The suite lease serializes calls; this gate also waits for earlier runs' deposits. */
export async function fundApproval(d: FundingDependencies, workflowId: string, actor: string, amount: string) {
  const approvalId = hashText(`approve:${workflowId}:${actor}`);
  const last = await d.journal.latest(BASE_CHAIN_ID, actor);
  if (last) {
    // Keep an approval with its run even if the process stops before signing its deposit.
    if (last.intentHash === hashCanonical(bondApproval(d.config.escrowAddress, amount)) && last._id !== approvalId) return false;
    // A crash may leave our approval signed but unbroadcast. Reuse its exact bytes.
    if (last._id === approvalId) {
      await d.beforeSigning();
      await d.signer.submit(approvalId, bondApproval(d.config.escrowAddress, amount));
    }
    if (!await finalized(d.gateway.base, last.evmHash)) return false;
  }
  const allowance = () => d.gateway.base.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance', args: [actor as Hex, d.config.escrowAddress], blockTag: 'finalized' });
  if (await allowance() >= BigInt(amount)) return true;
  await d.beforeSigning();
  const hash = await d.signer.submit(approvalId, bondApproval(d.config.escrowAddress, amount));
  return !!hash && await finalized(d.gateway.base, hash as Hex) && await allowance() >= BigInt(amount);
}

/** A saved unsigned operation still needs an allowance; an existing signature must only replay. */
export async function readyToDeposit(d: FundingDependencies, workflowId: string, actor: string, amount: string, operationId: string) {
  return !!await d.journal.get(operationId) || fundApproval(d, workflowId, actor, amount);
}
