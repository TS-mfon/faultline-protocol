import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { allocateRepair, hashCanonical, validateDecision, validateSnapshot, validateWorkflow } from '@faultline/protocol';
import FaultlineApp from '../../FaultlineApp';
import { api, ApiError, isWorkflow, listWorkflows } from '../api';
import { EvidenceInspector } from '../evidence-inspector';
import { localReplays } from '../replay';
import { money } from '../model';
import { WorkflowGraph } from '../workflow-graph';
import { ReceiptsPanel } from '../workflow-details';

afterEach(() => { vi.unstubAllGlobals(); });

describe('read-only replay integrity', () => {
  for (const replay of localReplays) {
    it(`${replay.workflow.manifest.domain} binds its real local snapshot, findings, and integer accounting`, () => {
      const workflow = replay.workflow;
      expect(workflow.mode).toBe('replay');
      validateWorkflow(workflow.manifest);
      validateSnapshot(workflow.manifest, replay.snapshot);
      validateDecision(workflow.manifest, replay.snapshot, workflow.decision!);
      expect(workflow.hash).toBe(hashCanonical(workflow.manifest));
      expect(workflow.decision!.snapshotHash).toBe(hashCanonical(replay.snapshot));
      const allocation = allocateRepair(workflow.manifest, workflow.decision!);
      expect(allocation.reduce((sum, row) => sum + BigInt(row.amount), 0n)).toBe(12000000n);
      expect(allocation.filter(row => row.weight > 0).map(row => row.amount)).toEqual(['9000000', '3000000']);
      expect(replay.operations.every(operation => operation.txHash === undefined && operation.intent === undefined)).toBe(true);
    });
  }
  it('renders a substantive first screen with explicit replay and no fabricated live receipts', () => {
    const html = renderToStaticMarkup(createElement(FaultlineApp));
    expect(html).toContain('Read-only replay');
    expect(html).toContain('Illustrative records. No live transactions or funds.');
    expect(html).toContain('Latency report');
    expect(html).toContain('Mandate graph');
    expect(html).toContain('Evidence inspector');
    expect(html).toContain('No live transactions');
    expect(html).not.toContain('>LIVE<');
    expect(html).toContain('Skip to investigation');
  });
  it('renders all navigation views without requesting data during render', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(renderToStaticMarkup(createElement(FaultlineApp, { initialView: 'agents' }))).toContain('Agent directory');
    expect(renderToStaticMarkup(createElement(FaultlineApp, { initialView: 'protocol' }))).toContain('Bridge and attestor trust');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('API truthfulness', () => {
  it('accepts empty data envelopes without silently creating a live record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [] })));
    expect(await listWorkflows()).toEqual([]);
  });
  it('preserves record modes and reads only the documented API prefix', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: localReplays.map(item => item.workflow) })); vi.stubGlobal('fetch', fetch);
    expect((await listWorkflows()).every(item => item.mode === 'replay')).toBe(true);
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/workflows');
  });
  it('rejects missing or invalid modes and malformed workflow state', async () => {
    const sample = localReplays[0]!.workflow;
    expect(isWorkflow({ ...sample, mode: undefined })).toBe(false);
    expect(isWorkflow({ ...sample, status: '__proto__' })).toBe(false);
    expect(isWorkflow({ ...sample, bonded: { a: '1.5' } })).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [{ ...sample, mode: 'test' }] })));
    await expect(listWorkflows()).rejects.toThrow('invalid workflow collection');
  });
  it('preserves service error codes and rejects non-enveloped responses', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    fetch.mockResolvedValueOnce(Response.json({ error: { code: 'NOT_CONFIGURED', message: 'Live service is not configured.' } }, { status: 503 }));
    await expect(api('/workflows')).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 });
    fetch.mockResolvedValueOnce(Response.json({ workflows: [] }));
    await expect(api('/workflows')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('investigation semantics', () => {
  it('makes every graph mandate keyboard selectable and supplies a list control', () => {
    const workflow = localReplays[0]!.workflow;
    const html = renderToStaticMarkup(createElement(WorkflowGraph, { workflow, selectedId: 'produce', onSelect: () => {} }));
    expect((html.match(/Inspect details\./g) ?? []).length).toBe(workflow.manifest.nodes.length);
    expect(html).toContain('>List</button>');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Depends on produce.');
  });
  it('escapes untrusted mandate content in the inspector', () => {
    const workflow = structuredClone(localReplays[0]!.workflow);
    workflow.manifest.nodes[1]!.specification = '<script>alert("injected")</script>';
    const html = renderToStaticMarkup(createElement(EvidenceInspector, { workflow, node: workflow.manifest.nodes[1]!, evidence: [], auditLoading: false, onNodeSelect: () => {} }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('shows execution and finality separately and flags a receipt binding mismatch', () => {
    const workflow = { ...localReplays[0]!.workflow, mode: 'live' as const };
    const html = renderToStaticMarkup(createElement(ReceiptsPanel, { workflow, initialOperations: [], onResume: () => {}, receipts: [{ transactionHash: `0x${'a'.repeat(64)}`, chain: 'base', chainId: 84532, execution: 'success', finality: 'pending', functionName: 'depositBond', workflowHash: `0x${'b'.repeat(64)}`, blockNumber: '1', to: '0x1' }] }));
    expect(html).toContain('Execution: success');
    expect(html).toContain('Finality: pending');
    expect(html).toContain('Workflow binding mismatch');
    expect(html).not.toContain('Finality: finalized');
  });
  it('formats USDC micro-units without rounding away value', () => {
    expect(money('1')).toBe('0.000001');
    expect(money('1200000000')).toBe('1,200.00');
    expect(money('900719925474099312345678')).toBe('900,719,925,474,099,312.345678');
    expect(money('-1')).toBe('Unavailable');
  });
});
