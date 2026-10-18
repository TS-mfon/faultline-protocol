import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, type Hex } from 'viem';
import { BASE_CHAIN_ID, hashCanonical, hashText, type TransactionIntent } from '@faultline/protocol';
import { FileSigningJournal } from '../src/journal';
import { fundApproval, readyToDeposit } from '../src/funding';
import type { SignedRecord } from '../../apps/worker/src/signer';

// Synthetic receipts exercise sequencing only; they are never live evidence.
const actor = `0x${'11'.repeat(20)}`, escrow = `0x${'22'.repeat(20)}` as Hex;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'faultline-allowance-')); directories.push(directory);
  const journal = new FileSigningJournal(join(directory, 'journal.json'));
  const receipts = new Map<string, any>(), signed: SignedRecord[] = [];
  let allowance = 0n, head = 0n, canonicalHash = hashText('canonical block'), interrupt = false;
  const base = {
    readContract: vi.fn(async () => allowance),
    getTransactionReceipt: vi.fn(async ({ hash }) => { const receipt = receipts.get(hash); if (!receipt) throw new Error('Transaction could not be found'); return receipt; }),
    getBlock: vi.fn(async ({ blockTag, blockNumber }) => ({ number: blockTag ? head : blockNumber, hash: canonicalHash })),
  };
  const signer = { submit: vi.fn(async (id: string, intent: TransactionIntent) => {
    let record = await journal.get(id);
    if (!record) {
      const nonce = await journal.latestNonce(BASE_CHAIN_ID, actor) + 1, raw = `0x${(nonce + 1).toString(16).padStart(2, '0')}` as Hex;
      record = { _id: id, intentHash: hashCanonical(intent), chainId: BASE_CHAIN_ID, from: actor, nonce, raw, evmHash: keccak256(raw) };
      await journal.insert(record); signed.push(record);
    }
    if (interrupt) { interrupt = false; throw new Error('interrupted after journaling'); }
    return record.evmHash;
  }) };
  const beforeSigning = vi.fn(async () => {});
  const dependencies = { journal, gateway: { base } as any, config: { escrowAddress: escrow } as any, signer, beforeSigning };
  return {
    journal, base, signer, signed, receipts, beforeSigning,
    approve: (workflow: string) => fundApproval(dependencies, workflow, actor, '12000000'),
    ready: (workflow: string, operation: string) => readyToDeposit(dependencies, workflow, actor, '12000000', operation),
    finalize(record: SignedRecord, amount: bigint) { head += 1n; allowance = amount; receipts.set(record.evmHash, { status: 'success', blockNumber: head, blockHash: canonicalHash }); },
    reorg() { canonicalHash = hashText('different canonical block'); },
    interrupt() { interrupt = true; },
  };
}

it('interleaved runs cannot reuse a finalized allowance while an earlier deposit is pending', async () => {
  const f = await fixture();
  expect(await f.approve('run-one')).toBe(false);
  const first = f.signed[0];
  f.base.readContract.mockClear();
  expect(await f.approve('run-two')).toBe(false);
  expect(f.base.readContract).not.toHaveBeenCalled(); expect(f.signed).toHaveLength(1);
  f.finalize(first, 12_000_000n);
  expect(await f.approve('run-two')).toBe(false);
  expect(await f.approve('run-one')).toBe(true);
  const deposit = { ...first, _id: hashText('first deposit'), intentHash: hashText('deposit intent'), nonce: 1, raw: '0xab' as Hex, evmHash: keccak256('0xab') };
  await f.journal.insert(deposit);
  await f.journal.insert({ ...first, _id: hashText('other chain'), chainId: 4221, nonce: 100 });
  await f.journal.insert({ ...first, _id: hashText('other actor'), from: escrow, nonce: 200 });
  f.base.readContract.mockClear();
  expect(await f.approve('run-two')).toBe(false);
  expect(f.base.readContract).not.toHaveBeenCalled(); expect(f.signed).toHaveLength(1);
  // Even an included deposit is insufficient until its block is finalized.
  f.receipts.set(deposit.evmHash, { status: 'success', blockNumber: 2n, blockHash: hashText('canonical block') });
  expect(await f.approve('run-two')).toBe(false);
  expect(f.base.readContract).not.toHaveBeenCalled();
  f.finalize(deposit, 0n);
  expect(await f.approve('run-two')).toBe(false); expect(f.signed).toHaveLength(2);
  const second = f.signed[1]; expect(second.nonce).toBe(2);
  expect(f.signer.submit.mock.calls.at(-1)![1].args).toEqual([escrow, '12000000']);
  f.finalize(second, 12_000_000n);
  expect(await f.approve('run-two')).toBe(true);
});

it('rejects reverted receipts and waits through a canonical-block mismatch before reading allowance', async () => {
  const f = await fixture(); await f.approve('first');
  const first = f.signed[0]; f.finalize(first, 12_000_000n); f.reorg();
  f.base.readContract.mockClear();
  expect(await f.approve('first')).toBe(false); expect(f.base.readContract).not.toHaveBeenCalled();
  f.receipts.get(first.evmHash).status = 'reverted';
  await expect(f.approve('first')).rejects.toMatchObject({ code: 'TRANSACTION_REVERTED' });
  expect(f.signed).toHaveLength(1);
});

it('resumes an approval interrupted after journaling without signing another transaction', async () => {
  const f = await fixture(); f.interrupt();
  await expect(f.approve('same-run')).rejects.toThrow('interrupted after journaling');
  const first = f.signed[0];
  expect(await f.approve('same-run')).toBe(false);
  f.finalize(first, 12_000_000n);
  expect(await f.approve('same-run')).toBe(true);
  expect(f.signed).toHaveLength(1);
  expect(await f.journal.latest(BASE_CHAIN_ID, actor)).toEqual(first);
  expect(await f.journal.latest(4221, actor)).toBeNull();
});

it('rechecks a persisted unsigned deposit but permits rebroadcast of the original signed deposit', async () => {
  const f = await fixture(); await f.approve('first');
  const approval = f.signed[0]; f.finalize(approval, 12_000_000n);
  const unsignedOperation = hashText('prepared before the runner stopped');
  expect(await f.ready('first', unsignedOperation)).toBe(true);
  expect(await f.ready('second', hashText('other prepared deposit'))).toBe(false);
  expect(await f.ready('first', unsignedOperation)).toBe(true);
  const deposit = { ...approval, _id: unsignedOperation, intentHash: hashText('deposit intent'), nonce: 1, raw: '0xab' as Hex, evmHash: keccak256('0xab') };
  await f.journal.insert(deposit);
  expect(await f.ready('second', hashText('other prepared deposit'))).toBe(false);
  expect(await f.ready('first', unsignedOperation)).toBe(true);
  f.finalize(deposit, 0n);
  // Only then may the second run create its own exact-amount approval.
  expect(await f.ready('second', hashText('other prepared deposit'))).toBe(false);
  expect(f.signed).toHaveLength(2);
});
