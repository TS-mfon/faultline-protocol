import { expect, it, vi } from 'vitest';
import { hashCanonical, hashText, type TransactionIntent } from '@faultline/protocol';
import type { GatewayReceipt } from '../src';
import { runOne } from '../../../apps/worker/src';
import { recoveryReady, R, A, WORKER } from './fixtures';

// Synthetic receipt responses isolate service accounting. No live withdrawal evidence.
async function context() {
  const { c, released } = await recoveryReady();
  await c.job('release', released);
  const intent: TransactionIntent = { chain: 'base', chainId: 84532, to: c.gateway.deployments.base.address, functionName: 'withdraw', args: [c.m.id], value: '0' };
  const txHash = hashText('observed-self-withdrawal');
  const receipt: GatewayReceipt = { transactionHash: txHash, chain: 'base', chainId: 84532, to: intent.to, from: R, functionName: 'withdraw', argsHash: hashCanonical(intent.args), value: '0', deploymentHash: c.gateway.deployments.base.codeHash, blockHash: hashText('observed-block'), blockNumber: '23', workflowId: c.m.id, workflowHash: hashCanonical(c.m), execution: 'success', finality: 'finalized', result: { ...released, beneficiary: R, withdrawnAmount: c.m.repairs[0]!.price, usdcTransferVerified: true } };
  const getWithdrawalReceipt = vi.fn(async () => ({ intent, receipt }));
  Object.assign(c.gateway, { getWithdrawalReceipt });
  return { c, intent, receipt, txHash, getWithdrawalReceipt };
}

it('reconciles a beneficiary self-withdrawal idempotently and retires an unsigned payout without spending', async () => {
  const { c, txHash } = await context();
  const [one, two] = await Promise.all([c.service.reconcileWithdrawal(c.m.id, txHash, R, WORKER), c.service.reconcileWithdrawal(c.m.id, txHash, R, WORKER)]);
  expect(one).toEqual(two);
  expect(one).toMatchObject({ kind: 'withdraw', status: 'completed', txHash, intent: { functionName: 'withdraw' } });
  expect((await c.service.getWorkflow(c.m.id)).status).toBe('completed');
  expect((await c.store.getWorkflow(c.m.id))!.receipts.filter(r => r.transactionHash === txHash)).toHaveLength(1);
  const submit = vi.fn(), materialize = vi.fn();
  expect(await runOne({ service: c.service, store: c.store, actor: WORKER, owner: 'reconcile-test', submit, materialize, now: c.now })).toBe('completed');
  expect(submit).not.toHaveBeenCalled(); expect(materialize).not.toHaveBeenCalled();
  const payout = (await c.store.listOperations(c.m.id)).find(op => op.kind === 'payout')!;
  expect(payout.operation.error?.code).toBe('WITHDRAWAL_RECONCILED');
  expect(payout.operation.txHash).toBeUndefined();
});

it.each(['pending', 'wrong deployment', 'wrong beneficiary', 'wrong self-sender', 'missing transfer', 'insufficient amount'])('rejects %s instead of completing a recovery', async fault => {
  const { c, txHash, receipt } = await context();
  if (fault === 'pending') receipt.finality = 'pending';
  if (fault === 'wrong deployment') receipt.deploymentHash = hashText('other deployment');
  if (fault === 'wrong beneficiary') (receipt.result as any).beneficiary = A;
  if (fault === 'wrong self-sender') receipt.from = A;
  if (fault === 'missing transfer') (receipt.result as any).usdcTransferVerified = false;
  if (fault === 'insufficient amount') (receipt.result as any).withdrawnAmount = '1';
  await expect(c.service.reconcileWithdrawal(c.m.id, txHash, R, WORKER)).rejects.toThrow();
  expect((await c.service.getWorkflow(c.m.id)).status).toBe('verifying_repair');
});

it('requires the configured worker for receipt reconciliation', async () => {
  const { c, txHash, getWithdrawalReceipt } = await context();
  await expect(c.service.reconcileWithdrawal(c.m.id, txHash, R, A)).rejects.toMatchObject({ code: 'WORKER_FORBIDDEN' });
  expect(getWithdrawalReceipt).not.toHaveBeenCalled();
});
