import { z } from 'zod';
import canonicalize from 'canonicalize';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const VERSION = 1 as const;
export const BASE_CHAIN_ID = 84532;
export const GENLAYER_CHAIN_ID = 4221;
export const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
export const MAX_EVIDENCE_BYTES = 65_536;
export const CLASS_CODES = { primary: 1, contributory: 2, downstream_consequence: 3, excused: 4, unresolved: 5 } as const;
export const WEIGHTS = { primary: 3, contributory: 1, downstream_consequence: 0, excused: 0, unresolved: 0 } as const;
export const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(x => x.toLowerCase());
export const HashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
export const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const AmountSchema = z.string().regex(/^(0|[1-9][0-9]{0,23})$/);
export const ResponsibilityClassSchema = z.enum(['primary', 'contributory', 'downstream_consequence', 'excused', 'unresolved']);
export type ResponsibilityClass = z.infer<typeof ResponsibilityClassSchema>;
const DutySchema = z.object({ id: IdSchema, description: z.string().min(1).max(2000) }).strict();
export const MandateSchema = z.object({ id: IdSchema, version: z.literal(1), agent: AddressSchema, title: z.string().min(1).max(120), specification: z.string().min(1).max(6000), dependencies: z.array(IdSchema).max(7), duties: z.array(DutySchema).max(12), exceptions: z.array(z.string().min(1).max(1000)).max(6), deadlineSeconds: z.number().int().min(60).max(172800) }).strict();
export const RepairActionSchema = z.object({ id: IdSchema, recipient: AddressSchema, price: AmountSchema, scope: z.string().min(1).max(4000), nodeIds: z.array(IdSchema).min(1).max(8) }).strict();
export const WorkflowManifestSchema = z.object({ schemaVersion: z.literal(1), id: HashSchema, title: z.string().min(1).max(160), domain: z.enum(['software', 'research', 'procurement']), creator: AddressSchema, nodes: z.array(MandateSchema).min(1).max(8), bonds: z.record(z.string(), AmountSchema), repairCap: AmountSchema, repairs: z.array(RepairActionSchema).min(1).max(8), referenceHashes: z.array(HashSchema).max(32), policy: z.object({ version: z.literal(1), responseWindowSeconds: z.number().int().min(60).max(86400), cureWindowSeconds: z.literal(86400), repairWindowSeconds: z.literal(172800), lockDurationSeconds: z.literal(604800), reportWindowSeconds: z.literal(86400), classWeights: z.object({ primary: z.literal(3), contributory: z.literal(1) }).strict() }).strict() }).strict();
export type WorkflowManifest = z.infer<typeof WorkflowManifestSchema>;
export type Mandate = z.infer<typeof MandateSchema>;
export type RepairAction = z.infer<typeof RepairActionSchema>;
export const ArtifactSchema = z.object({ hash: HashSchema, uri: z.string().url(), mediaType: z.enum(['text/plain', 'application/json', 'text/markdown', 'text/x-python', 'text/javascript']), size: z.number().int().min(1).max(16_777_216) }).strict();
export const HandoffManifestSchema = z.object({ schemaVersion: z.literal(1), id: HashSchema, workflowId: HashSchema, nodeId: IdSchema, mandateVersion: z.literal(1), artifactVersion: z.number().int().positive(), artifact: ArtifactSchema, inputs: z.array(z.object({ nodeId: IdSchema, handoffId: HashSchema, artifactHash: HashSchema }).strict()).max(7), producer: AddressSchema }).strict();
export type HandoffManifest = z.infer<typeof HandoffManifestSchema>;
export const EvidenceItemSchema = z.object({ id: IdSchema, hash: HashSchema, text: z.string().min(1), submittedBy: AddressSchema, sourceHash: HashSchema.optional(), sourceLabel: z.string().max(500).optional() }).strict();
export const EvidenceSnapshotSchema = z.object({ schemaVersion: z.literal(1), workflowId: HashSchema, caseId: HashSchema, round: z.union([z.literal(1), z.literal(2)]), workflowHash: HashSchema, evidence: z.array(EvidenceItemSchema).min(1).max(64), handoffs: z.array(HandoffManifestSchema).max(64), acknowledgments: z.array(z.object({ handoffId: HashSchema, agent: AddressSchema, txHash: HashSchema }).strict()).max(128), report: z.object({ nodeId: IdSchema, impact: z.string().min(1).max(4000), reporter: AddressSchema }).strict() }).strict();
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;
export const DecisionSchema = z.object({ schemaVersion: z.literal(1), workflowId: HashSchema, caseId: HashSchema, snapshotHash: HashSchema, outcome: z.enum(['DECIDED', 'NEEDS_EVIDENCE', 'UNRESOLVED']), findings: z.array(z.object({ nodeId: IdSchema, class: ResponsibilityClassSchema, dutyIds: z.array(IdSchema).max(12), evidenceRefs: z.array(IdSchema).min(1).max(32), reason: z.string().min(1).max(4000) }).strict()).max(8), edges: z.array(z.object({ from: IdSchema, to: IdSchema, evidenceRefs: z.array(IdSchema).min(1).max(32) }).strict()).max(16), remedyId: IdSchema.nullable(), requestedEvidence: z.array(z.string().min(1).max(1000)).max(12), rationale: z.string().min(1).max(6000) }).strict();
export type ResponsibilityDecision = z.infer<typeof DecisionSchema>;
export const RepairSubmissionSchema = z.object({ schemaVersion: z.literal(1), workflowId: HashSchema, caseId: HashSchema, remedyId: IdSchema, recipient: AddressSchema, artifacts: z.array(ArtifactSchema).min(1).max(8), evidence: z.array(EvidenceItemSchema).min(1).max(32), previousHashes: z.array(HashSchema).min(1).max(8) }).strict();
export type RepairSubmission = z.infer<typeof RepairSubmissionSchema>;
export const OperationStatusSchema = z.enum(['queued', 'awaiting_signature', 'submitted', 'confirming', 'completed', 'failed']);
export type Operation = { id: string; kind: string; status: z.infer<typeof OperationStatusSchema>; workflowId?: string; txHash?: string; result?: unknown; error?: { code: string; message: string }; intent?: TransactionIntent; createdAt: string; updatedAt: string };
export type TransactionIntent = { chain: 'base' | 'genlayer'; chainId: number; to: string; functionName: string; args: unknown[]; value?: string; abi?: unknown[] };
export type WorkflowStatus = 'draft' | 'funding' | 'active' | 'suspended' | 'evidence_open' | 'adjudicating' | 'needs_evidence' | 'decided' | 'repairing' | 'verifying_repair' | 'completed' | 'unresolved' | 'recovery_failed' | 'expired';
export type WorkflowRecord = { manifest: WorkflowManifest; hash: string; status: WorkflowStatus; createdAt: string; expiresAt: string; accepted: string[]; bonded: Record<string, string>; handoffs: HandoffManifest[]; acknowledgments: { handoffId: string; agent: string; txHash: string }[]; suspendedNodes: string[]; decision?: ResponsibilityDecision; caseId?: string; responseDeadline?: string; evidenceRound?: 1 | 2; repairDeadline?: string; mode: 'live' | 'replay'; revision: number };
export class ProtocolError extends Error { constructor(public code: string, message: string) { super(message); this.name = 'ProtocolError'; } }
export function canonical(value: unknown): string { const result = canonicalize(value); if (result === undefined) throw new ProtocolError('INVALID_JSON', 'Value cannot be canonically encoded'); return result; }
export function hashBytes(bytes: Uint8Array): `0x${string}` { return `0x${bytesToHex(sha256(bytes))}`; }
export function hashText(text: string): `0x${string}` { return hashBytes(utf8ToBytes(text)); }
export function hashCanonical(value: unknown): `0x${string}` { return hashText(canonical(value)); }
export function participants(m: WorkflowManifest): string[] { return [...new Set(m.nodes.map(n => n.agent))].sort(); }
function requireThat(condition: unknown, code: string, message: string): asserts condition { if (!condition) throw new ProtocolError(code, message); }
export function validateWorkflow(input: unknown): WorkflowManifest {
  const m = WorkflowManifestSchema.parse(input), ids = new Set(m.nodes.map(n => n.id));
  requireThat(ids.size === m.nodes.length, 'DUPLICATE_NODE', 'Node IDs must be unique');
  requireThat(BigInt(m.repairCap) > 0n, 'INVALID_CAP', 'Repair cap must be positive');
  requireThat(m.nodes.reduce((s, n) => s + n.dependencies.length, 0) <= 16, 'EDGE_LIMIT', 'At most 16 edges');
  for (const n of m.nodes) {
    requireThat(new Set(n.dependencies).size === n.dependencies.length, 'DUPLICATE_EDGE', 'Dependencies must be unique');
    requireThat(n.dependencies.every(x => ids.has(x) && x !== n.id), 'UNKNOWN_DEPENDENCY', 'Invalid dependency');
    requireThat(new Set(n.duties.map(d => d.id)).size === n.duties.length, 'DUPLICATE_DUTY', 'Duties must be unique');
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => { requireThat(!visiting.has(id), 'CYCLIC_GRAPH', 'Workflow must be acyclic'); if (visited.has(id)) return; visiting.add(id); m.nodes.find(n => n.id === id)!.dependencies.forEach(visit); visiting.delete(id); visited.add(id); };
  m.nodes.forEach(n => visit(n.id));
  const agents = participants(m), normalized: Record<string, string> = {};
  for (const [key, amount] of Object.entries(m.bonds)) { const addr = AddressSchema.parse(key); requireThat(!(addr in normalized), 'DUPLICATE_BOND', 'Duplicate bond owner'); normalized[addr] = amount; }
  requireThat(Object.keys(normalized).length === agents.length && agents.every(a => a in normalized && BigInt(normalized[a]!) >= BigInt(m.repairCap)), 'INSUFFICIENT_BOND', 'Each participant must bond at least the repair cap');
  m.bonds = normalized;
  requireThat(new Set(m.repairs.map(r => r.id)).size === m.repairs.length, 'DUPLICATE_REMEDY', 'Repair IDs must be unique');
  for (const r of m.repairs) { requireThat(BigInt(r.price) > 0n && BigInt(r.price) <= BigInt(m.repairCap), 'REPAIR_CAP', 'Repair price exceeds cap'); requireThat(new Set(r.nodeIds).size === r.nodeIds.length && r.nodeIds.every(id => ids.has(id)), 'UNKNOWN_REPAIR_NODE', 'Repair references invalid nodes'); }
  requireThat(utf8ToBytes(canonical(m)).length <= MAX_EVIDENCE_BYTES, 'MANIFEST_TOO_LARGE', 'Manifest exceeds limit');
  return m;
}
export function descendants(m: WorkflowManifest, roots: string[]): string[] { const result = new Set(roots); let changed = true; while (changed) { changed = false; for (const n of m.nodes) if (!result.has(n.id) && n.dependencies.some(d => result.has(d))) { result.add(n.id); changed = true; } } return m.nodes.filter(n => result.has(n.id)).map(n => n.id); }
export function validateHandoff(m: WorkflowManifest, input: unknown, previous: HandoffManifest[]): HandoffManifest {
  const h = HandoffManifestSchema.parse(input), n = m.nodes.find(n => n.id === h.nodeId);
  requireThat(h.workflowId === m.id && n && h.producer === n.agent, 'HANDOFF_OWNER', 'Handoff does not match mandate owner');
  requireThat(h.inputs.length === n.dependencies.length && new Set(h.inputs.map(x => x.nodeId)).size === h.inputs.length && h.inputs.every(i => n.dependencies.includes(i.nodeId)), 'INPUT_SET', 'Declared inputs must exactly match dependencies');
  for (const i of h.inputs) { const latest = previous.filter(x => x.nodeId === i.nodeId).sort((a,b) => b.artifactVersion-a.artifactVersion)[0]; requireThat(latest && latest.id === i.handoffId && latest.artifact.hash === i.artifactHash, 'STALE_INPUT', 'Input must reference the latest upstream artifact'); }
  const old = previous.filter(x => x.nodeId === h.nodeId); requireThat(!previous.some(x => x.id === h.id) && h.artifactVersion === Math.max(0, ...old.map(x => x.artifactVersion)) + 1, 'STALE_VERSION', 'Artifact version must increase exactly once');
  return h;
}
export function validateSnapshot(m: WorkflowManifest, input: unknown): EvidenceSnapshot {
  const s = EvidenceSnapshotSchema.parse(input);
  requireThat(s.workflowId === m.id && s.workflowHash === hashCanonical(m), 'SNAPSHOT_BINDING', 'Snapshot must bind the accepted workflow');
  requireThat(utf8ToBytes(canonical(s)).length <= MAX_EVIDENCE_BYTES, 'EVIDENCE_TOO_LARGE', 'Evidence packet exceeds 64 KiB');
  requireThat(new Set(s.evidence.map(e => e.id)).size === s.evidence.length, 'DUPLICATE_EVIDENCE', 'Evidence IDs must be unique');
  requireThat(s.evidence.every(e => hashText(e.text) === e.hash), 'EVIDENCE_HASH', 'Evidence bytes do not match hash');
  requireThat(m.nodes.some(n => n.id === s.report.nodeId) && participants(m).includes(s.report.reporter), 'REPORT_SCOPE', 'Invalid failure reporter or node');
  return s;
}
export function validateDecision(m: WorkflowManifest, s: EvidenceSnapshot, input: unknown): ResponsibilityDecision {
  const d = DecisionSchema.parse(input), evidenceIds = new Set(s.evidence.map(e => e.id));
  requireThat(d.workflowId === m.id && d.caseId === s.caseId && d.snapshotHash === hashCanonical(s), 'DECISION_BINDING', 'Decision must bind the frozen snapshot');
  requireThat(new Set(d.findings.map(f => f.nodeId)).size === d.findings.length, 'DUPLICATE_FINDING', 'Only one finding per node');
  const connected = new Set(descendants(m, [s.report.nodeId]));
  const addAncestors = (id: string) => { for (const dep of m.nodes.find(n => n.id === id)!.dependencies) if (!connected.has(dep)) { connected.add(dep); addAncestors(dep); } }; addAncestors(s.report.nodeId);
  for (const f of d.findings) { const n = m.nodes.find(n => n.id === f.nodeId); requireThat(n && connected.has(n.id), 'FINDING_SCOPE', 'Finding is outside the disputed dependency path'); requireThat(f.dutyIds.every(id => n.duties.some(x => x.id === id)), 'UNKNOWN_DUTY', 'Finding names an unaccepted duty'); requireThat(f.class !== 'contributory' || f.dutyIds.length > 0, 'NO_DETECTION_DUTY', 'Contributory responsibility requires an explicit duty'); requireThat(f.class !== 'excused' || n.exceptions.length > 0, 'NO_EXCEPTION', 'Excused responsibility requires an agreed exception'); requireThat(f.evidenceRefs.every(id => evidenceIds.has(id)), 'UNKNOWN_EVIDENCE', 'Finding cites missing evidence'); }
  for (const e of d.edges) requireThat(m.nodes.some(n => n.id === e.to && n.dependencies.includes(e.from)) && e.evidenceRefs.every(id => evidenceIds.has(id)), 'INVALID_CAUSAL_EDGE', 'Responsibility edges must be evidenced workflow dependencies');
  requireThat(d.outcome === 'DECIDED' || d.remedyId === null, 'UNRESOLVED_AWARD', 'Non-decided cases cannot allocate funds');
  requireThat(!d.findings.some(f => f.class === 'unresolved') || d.remedyId === null, 'UNRESOLVED_AWARD', 'Unresolved material findings block an award');
  if (d.remedyId) { const r = m.repairs.find(r => r.id === d.remedyId); requireThat(r, 'UNKNOWN_REMEDY', 'Repair was not agreed'); const liable = d.findings.filter(f => WEIGHTS[f.class] > 0).map(f => m.nodes.find(n => n.id === f.nodeId)!.agent); requireThat(liable.length > 0 && !liable.includes(r.recipient), 'SELF_AWARD', 'A liable agent cannot receive its own award'); }
  return d;
}
export type Allocation = { agent: string; weight: number; amount: string };
export function allocateRepair(m: WorkflowManifest, d: ResponsibilityDecision): Allocation[] {
  if (d.outcome !== 'DECIDED' || !d.remedyId || d.findings.some(f => f.class === 'unresolved')) return [];
  const repair = m.repairs.find(r => r.id === d.remedyId); requireThat(repair, 'UNKNOWN_REMEDY', 'Repair was not agreed');
  const weights = new Map(participants(m).map(a => [a, 0]));
  const seen = new Set<string>(); for (const f of d.findings) { const node = m.nodes.find(n => n.id === f.nodeId); requireThat(node && !seen.has(f.nodeId), 'FINDING_SCOPE', 'Invalid or duplicate finding'); seen.add(f.nodeId); weights.set(node.agent, weights.get(node.agent)! + WEIGHTS[f.class]); }
  requireThat((weights.get(repair.recipient) ?? 0) === 0, 'SELF_AWARD', 'Repair recipient is liable');
  const total = [...weights.values()].reduce((a,b) => a+b, 0); requireThat(total > 0, 'NO_LIABILITY', 'Award requires liability');
  const price = BigInt(repair.price), result = [...weights].map(([agent, weight]) => ({agent, weight, value: price * BigInt(weight) / BigInt(total)}));
  let remaining = price-result.reduce((s,a)=>s+a.value,0n); for (const a of result) if (remaining > 0n && a.weight > 0) { a.value++; remaining--; }
  for (const a of result) requireThat(a.value <= BigInt(m.bonds[a.agent]!), 'BOND_CAP', 'Allocation exceeds agent cap');
  return result.map(({agent,weight,value})=>({agent,weight,amount:String(value)}));
}
export function substantiveDecision(d: ResponsibilityDecision): unknown { return { outcome: d.outcome, findings: d.findings.map(({nodeId,class:className,dutyIds})=>({nodeId,class:className,dutyIds:[...dutyIds].sort()})).sort((a,b)=>a.nodeId.localeCompare(b.nodeId)), edges:d.edges.map(({from,to})=>({from,to})).sort((a,b)=>(a.from+a.to).localeCompare(b.from+b.to)), remedyId:d.remedyId }; }
export function formatUsdc(units: string): string { const n=BigInt(units); return `${n/1000000n}.${String(n%1000000n).padStart(6,'0').replace(/0+$/,'')||'00'}`; }
export const DEFAULT_POLICY: WorkflowManifest['policy'] = { version:1, responseWindowSeconds:86400,cureWindowSeconds:86400,repairWindowSeconds:172800,lockDurationSeconds:604800,reportWindowSeconds:86400,classWeights:{primary:3,contributory:1} };
