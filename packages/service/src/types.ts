import type { EvidenceSnapshot, Operation, RepairSubmission, TransactionIntent, WorkflowRecord } from '@faultline/protocol';

export type Mode = 'live' | 'replay';
export type OperationKind = 'register' | 'provision_escrow' | 'accept' | 'fund' | 'activate_escrow' | 'activate' | 'handoff' | 'acknowledge' | 'report' | 'open_case_escrow' | 'evidence' | 'close_evidence' | 'adjudicate' | 'reserve' | 'repair' | 'verify_repair' | 'release' | 'payout' | 'refund_escrow' | 'withdraw' | 'expire';
export interface Bindings {
  workflowId: string;
  workflowHash: string;
  caseId?: string;
  snapshotHash?: string;
  decisionHash?: string;
  repairHash?: string;
}
/** No private keys or signing methods belong in this interface. */
export interface GatewayCommand {
  kind: OperationKind;
  actor: string;
  workflow: WorkflowRecord;
  payload: unknown;
  bindings: Bindings;
}
export interface Deployment {
  chainId: number;
  address: string;
  codeHash: string;
  /** Set only after independently checking the deployed runtime against an approved build. */
  verified: boolean;
}
export interface GatewayReceipt extends Bindings {
  transactionHash: string;
  chain: TransactionIntent['chain'];
  chainId: number;
  to: string;
  from: string;
  functionName: string;
  /** SHA256 of RFC8785 canonical decoded function arguments, not a caller assertion. */
  argsHash: string;
  value: string;
  deploymentHash: string;
  blockHash: string;
  blockNumber: string;
  execution: 'success' | 'reverted' | 'pending' | 'undetermined';
  finality: 'finalized' | 'pending';
  /** Decoded finalized chain view/event, e.g. {decision}, {repairAccepted}, {amount}. */
  result?: unknown;
}
/** Receipt readers MUST independently fetch chain truth, including native finality and execution.
 * No elapsed-time, supplied tx hash, replay, or successful submission is finality evidence.
 * Bindings/result come from decoded chain state/events or authenticated attestor evidence.
 */
export interface ChainGateway {
  readonly mode: Mode;
  readonly deployments: Readonly<Record<TransactionIntent['chain'], Deployment>>;
  prepare(command: GatewayCommand): Promise<TransactionIntent>;
  getReceipt(txHash: string, intent: TransactionIntent): Promise<GatewayReceipt | null>;
  getReputation(agent: string): Promise<unknown>;
  nativeAppealStatus?(txHash: string): Promise<{ canAppeal: boolean; canFinalize: boolean; observedBlock: string; status: string; successfulFinality: boolean; nativeTiming: unknown }>;
  getWithdrawalReceipt?(txHash: string, workflowId: string, beneficiary: string): Promise<{ intent: TransactionIntent; receipt: GatewayReceipt } | null>;
}
export interface StoredWorkflow {
  record: WorkflowRecord;
  report?: EvidenceSnapshot['report'];
  evidence: EvidenceSnapshot['evidence'];
  closedBy: string[];
  snapshots: { hash: string; url: string; snapshot: EvidenceSnapshot }[];
  receipts: GatewayReceipt[];
  repair?: RepairSubmission;
  repairHash?: string;
  escrowReady: boolean;
  baseCaseOpened: boolean;
  activatedAt?: string;
  cureDeadline?: string;
  fundingReceipt?: unknown;
  repairVerdictId?: string;
  reserved: boolean;
  repairVerified: boolean;
  /** Last frozen snapshot is kept immutable while the next evidence round is open. */
  currentSnapshotHash?: string;
}
export interface StoredOperation {
  operation: Operation;
  kind: OperationKind;
  actor: string;
  payload: unknown;
  bindings: Bindings;
  mode: Mode;
  revision: number;
  worker: boolean;
}
export interface DurableJob {
  id: string;
  workflowId: string;
  operationId: string;
  kind: OperationKind;
  state: 'queued' | 'leased' | 'completed' | 'failed';
  availableAt: number;
  attempts: number;
  revision: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseUntil?: number;
}
export interface JobLease extends DurableJob {
  state: 'leased'; leaseOwner: string; leaseToken: string; leaseUntil: number;
}
export interface OutboxEvent {
  id: string;
  workflowId: string;
  operationId: string;
  type: string;
  createdAt: number;
  payload: unknown;
  deliveredAt?: number;
}
export interface IdempotencyRecord { scope: string; key: string; requestHash: string; operationId: string }
export interface AuthChallenge {
  id: string; address: string; message: string; expiresAt: number; consumedAt?: number;
}
export interface ChangeSet {
  workflow?: { expectedRevision: number | null; value: StoredWorkflow };
  operations?: { expectedRevision: number | null; value: StoredOperation }[];
  jobs?: DurableJob[];
  outbox?: OutboxEvent[];
  idempotency?: IdempotencyRecord;
  /** Atomic fencing: a stale/expired worker cannot commit a result. */
  lease?: { id: string; owner: string; token: string; now: number; complete?: boolean };
}
export interface Store {
  readonly durability: 'memory' | 'durable';
  getWorkflow(id: string): Promise<StoredWorkflow | null>;
  listWorkflows(): Promise<StoredWorkflow[]>;
  getOperation(id: string): Promise<StoredOperation | null>;
  listOperations(workflowId: string): Promise<StoredOperation[]>;
  /** Atomically commits everything or throws REVISION_CONFLICT/IDEMPOTENCY_CONFLICT/LEASE_LOST. */
  commit(change: ChangeSet): Promise<void>;
  getIdempotency(scope: string, key: string): Promise<IdempotencyRecord | null>;
  claimJob(owner: string, now: number, leaseMs: number): Promise<JobLease | null>;
  renewLease(id: string, owner: string, token: string, now: number, leaseMs: number): Promise<JobLease>;
  retryJob(id: string, owner: string, token: string, now: number, availableAt: number): Promise<void>;
  listOutbox(limit?: number): Promise<OutboxEvent[]>;
  acknowledgeOutbox(id: string, deliveredAt: number): Promise<void>;
  /** Returns content-addressed SHA256. Rejects an incorrect supplied hash. */
  putEvidence(bytes: Uint8Array, expectedHash?: string): Promise<string>;
  getEvidence(hash: string): Promise<Uint8Array | null>;
  putChallenge(challenge: AuthChallenge): Promise<void>;
  getChallenge(id: string): Promise<AuthChallenge | null>;
  consumeChallenge(id: string, now: number): Promise<boolean>;
}
export interface ServiceOptions {
  evidenceOrigin: string;
  now?: () => number;
  /** Trusted worker EOAs only; neither these addresses nor bearer tokens authorize spending. */
  workerActors?: Partial<Record<TransactionIntent['chain'], string>>;
}
export interface AuthOptions {
  /** Server-only HMAC secret from env; at least 32 bytes, never a wallet private key. */
  secret: string;
  origin: string;
  audience: string;
  now?: () => number;
  challengeTtlMs?: number;
  tokenTtlMs?: number;
}
