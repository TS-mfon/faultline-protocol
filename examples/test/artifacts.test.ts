import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { immutableJson } from '../src/journal';
import { executeTask } from '../src/tasks';
import { artifact } from '../src/artifacts';
import { initialState } from '../src/live';
import { scenarios, replay } from '../src/scenarios';

it('concurrent publication is idempotent and conflicting evidence preserves the original bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'faultline-evidence-'));
  try {
    const path = join(directory, 'evidence.json');
    const value = { mode: 'test-only', commitment: 'original', quantity: '12000000' };
    await Promise.all(Array.from({ length: 8 }, () => immutableJson(path, value)));
    const original = await readFile(path, 'utf8');
    await expect(immutableJson(path, { ...value, quantity: '1' })).rejects.toThrow('Immutable evidence conflict');
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['evidence.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('a consensus record stays fixed while later repair and cleanup operations advance', () => {
  const demo = replay('software');
  const state = initialState('software', { creator: demo.manifest.creator, agents: demo.manifest.nodes.map(node => node.agent) as [string, string, string], repairer: demo.manifest.repairs[0].recipient }, 'test-only');
  for (const task of ['produce', 'review', 'publish'] as const) {
    const previous = task === 'review' ? 'produce' : task === 'publish' ? 'review' : undefined;
    state.work[task] = { state: 'complete', output: executeTask({ domain: 'software', task, source: scenarios.software.source, ...(previous ? { upstream: state.work[previous].output!.text } : {}) }) };
  }
  const audit = { mode: 'replay', workflow: { mode: 'replay', manifest: demo.manifest, hash: 'test-only', decision: demo.decision, status: 'decided', revision: 1 }, operations: [{ id: 'test-judge', kind: 'adjudicate', status: 'completed' }], snapshots: [{ hash: demo.decision.snapshotHash, snapshot: demo.snapshot }] };
  const frozen = artifact(state, audit, 'consensus');
  const advanced = structuredClone(audit);
  advanced.workflow.status = 'completed'; advanced.workflow.revision++;
  advanced.operations.push({ id: 'test-payment', kind: 'payout', status: 'completed' });
  expect(artifact(state, advanced, 'consensus')).toEqual(frozen);
  expect(frozen.execution).toBe('deterministic-agents-with-genlayer-consensus');
  expect(frozen.audit.mode).toBe('replay');
  expect(() => artifact(state, audit, 'recovery')).toThrow('missing task output');
});
