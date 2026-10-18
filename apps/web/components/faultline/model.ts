import type { Mandate, Operation, ResponsibilityClass, WorkflowManifest, WorkflowRecord } from '@faultline/protocol';

export type View = 'workflows' | 'agents' | 'protocol';
export type Domain = WorkflowManifest['domain'];
export type Evidence = { id: string; hash: string; text: string; submittedBy: string; sourceLabel?: string; sourceHash?: string };
export type ChainReceipt = { transactionHash: string; chain: 'base' | 'genlayer'; chainId: number; execution: 'success' | 'reverted' | 'pending' | 'undetermined'; finality: 'finalized' | 'pending'; functionName: string; workflowHash: string; blockNumber: string; to: string; [key: string]: unknown };
export type Audit = { workflow?: WorkflowRecord; evidence?: Evidence[]; operations?: Operation[]; receipts?: ChainReceipt[]; [key: string]: unknown };
export type Tone = 'amber' | 'coral' | 'teal' | 'neutral';
export const domains: Domain[] = ['software', 'research', 'procurement'];
export const classLabels: Record<ResponsibilityClass, string> = { primary: 'Primary', contributory: 'Contributory', downstream_consequence: 'Downstream', excused: 'Excused', unresolved: 'Unresolved' };
export const statusLabels: Record<WorkflowRecord['status'], string> = { draft: 'Draft', funding: 'Awaiting funding', active: 'Active', suspended: 'Suspended', evidence_open: 'Evidence open', adjudicating: 'Adjudicating', needs_evidence: 'Needs evidence', decided: 'Decision recorded', repairing: 'Repair in progress', verifying_repair: 'Verifying repair', completed: 'Completed', unresolved: 'Unresolved', recovery_failed: 'Recovery failed', expired: 'Expired' };
export const operationLabels: Record<Operation['status'], string> = { queued: 'Queued', awaiting_signature: 'Awaiting signature', submitted: 'Submitted', confirming: 'Confirming', completed: 'Completed', failed: 'Failed' };
export function shortId(value: string, count = 6): string { return value.length > count * 2 + 3 ? `${value.slice(0, count + 2)}…${value.slice(-count)}` : value; }
export function money(units: string): string {
  if (!/^(0|[1-9]\d*)$/.test(units)) return 'Unavailable';
  const value = BigInt(units), fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${(value / 1_000_000n).toLocaleString('en-US')}.${fraction}`;
}
export function dateTime(value?: string): string { if (!value) return 'Not recorded'; const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Not recorded' : new Intl.DateTimeFormat('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(date) + ' UTC'; }
export function toneForClass(value?: ResponsibilityClass): Tone { return value === 'primary' ? 'amber' : value === 'contributory' ? 'coral' : value === 'excused' ? 'teal' : 'neutral'; }
export function nodeState(workflow: WorkflowRecord, node: Mandate): { label: string; tone: Tone } {
  const finding = workflow.decision?.findings.find(item => item.nodeId === node.id);
  if (finding) return { label: classLabels[finding.class], tone: toneForClass(finding.class) };
  if (workflow.suspendedNodes.includes(node.id)) return { label: 'Suspended', tone: 'coral' };
  if (workflow.handoffs.some(item => item.nodeId === node.id)) return { label: 'Handoff recorded', tone: 'teal' };
  return { label: 'Awaiting handoff', tone: 'neutral' };
}
