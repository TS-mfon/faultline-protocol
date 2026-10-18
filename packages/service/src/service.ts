import { AsyncLocalStorage } from 'node:async_hooks';
import {
  AddressSchema, HashSchema, EvidenceItemSchema, RepairSubmissionSchema,
  BASE_CHAIN_ID, GENLAYER_CHAIN_ID, canonical, hashCanonical, hashText,
  validateWorkflow, validateHandoff, validateSnapshot, validateDecision, participants, descendants,
  type WorkflowManifest, type WorkflowRecord, type Operation, type TransactionIntent,
  type HandoffManifest, type EvidenceSnapshot, type RepairSubmission,
} from '@faultline/protocol';
import { check, parse, ProtocolError } from './errors';
import { copy, findIdempotentOperation, validateIdempotencyKey } from './store';
import type { Bindings, ChainGateway, ChangeSet, DurableJob, GatewayCommand, GatewayReceipt, JobLease, Mode, OperationKind, OutboxEvent, ServiceOptions, Store, StoredOperation, StoredWorkflow } from './types';

type EvidenceItem = EvidenceSnapshot['evidence'][number];
type Report = { nodeId: string; impact: string };
const ACTIONS: Record<OperationKind, [TransactionIntent['chain'], string]> = {
  register: ['genlayer','register_workflow'], provision_escrow: ['base','createWorkflow'], accept: ['genlayer','accept_mandate'],
  fund: ['base','depositBond'], activate_escrow: ['base','activateWorkflow'], activate: ['genlayer','activate_workflow'],
  handoff: ['genlayer','record_handoff'], acknowledge: ['genlayer','acknowledge_handoff'], report: ['genlayer','open_case'], open_case_escrow: ['base','openCase'],
  evidence: ['genlayer','submit_evidence'], close_evidence: ['genlayer','close_evidence'], adjudicate: ['genlayer','adjudicate'],
  reserve: ['base','reserveAward'], repair: ['genlayer','submit_repair'], verify_repair: ['genlayer','verify_repair'],
  release: ['base','releaseRepair'], payout: ['base','withdrawFor'], withdraw: ['base','withdrawFor'], refund_escrow: ['base','refundExpired'], expire: ['genlayer','expire_workflow'],
};
const WORKER_KINDS = new Set<OperationKind>(['provision_escrow','open_case_escrow','activate_escrow','activate','adjudicate','reserve','verify_repair','release','payout','withdraw','refund_escrow','expire']);
const CLEANUP = new Set<OperationKind>(['payout','withdraw','refund_escrow','expire']);
const CLOSED = new Set(['completed','unresolved','recovery_failed','expired']);
const pending = (op: StoredOperation) => !['completed','failed'].includes(op.operation.status);

export class FaultlineService {
  private readonly now: () => number;
  private readonly requestKeys = new AsyncLocalStorage<string>();
  private readonly origin: string;
  constructor(readonly store: Store, readonly chainGateway: ChainGateway, private readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now;
    const url = new URL(options.evidenceOrigin);
    check(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)), 'SERVICE_CONFIGURATION','Evidence origin must use HTTPS');
    check(!url.username && !url.password && !url.search && !url.hash,'SERVICE_CONFIGURATION','Evidence origin must not contain credentials, a query, or a fragment');
    this.origin = options.evidenceOrigin.replace(/\/$/,'');
  }
  /** Router must first verify bearer wallet and require Idempotency-Key for mutations. */
  withIdempotency<T>(key: string, callback: () => Promise<T>): Promise<T> {
    validateIdempotencyKey(key); return this.requestKeys.run(key,callback);
  }
  async createWorkflow(input: WorkflowManifest, actor: string, mode: Mode = 'live'): Promise<Operation> {
    actor = parse(AddressSchema,actor); const manifest = this.validManifest(input);
    check(manifest.creator === actor,'FORBIDDEN','Only the manifest creator may register it');
    this.assertMode(mode);
    const hash = hashCanonical(manifest), id = manifest.id, payload = manifest;
    const scope = `${actor}:register`, key = this.requestKeys.getStore() ?? hashCanonical({kind:'register',mode,manifest});
    const requestHash = hashCanonical({kind:'register',mode,manifest});
    const previous = await findIdempotentOperation(this.store,scope,key,requestHash); if (previous) return this.publicOperation(previous);
    check(!await this.store.getWorkflow(id),'WORKFLOW_EXISTS','Workflow ID already exists with immutable terms');
    const now = this.now();
    const w: StoredWorkflow = { record: { manifest,hash,status:'draft',createdAt:this.iso(now),expiresAt:this.iso(now + manifest.policy.lockDurationSeconds*1000),accepted:[],bonded:{},handoffs:[],acknowledgments:[],suspendedNodes:[],mode,revision:0 }, evidence:[],closedBy:[],snapshots:[],receipts:[],escrowReady:false,baseCaseOpened:false,reserved:false,repairVerified:false };
    await this.store.putEvidence(Buffer.from(canonical(manifest)),hash);
    const op = this.makeOperation('register',w,actor,payload,false);
    op.operation.intent = await this.prepareIntent(op,w);
    const c: ChangeSet = { workflow: {expectedRevision:null,value:w},operations:[{expectedRevision:null,value:op}],idempotency:{scope,key,requestHash,operationId:op.operation.id},outbox:[this.event(op,'operation.awaiting_signature')] };
    try { await this.store.commit(c); } catch (error) { const saved = await this.idempotentAfterConflict(error,scope,key,requestHash); if (saved) return saved; throw error; }
    return copy(op.operation);
  }
  async getWorkflow(id: string): Promise<WorkflowRecord> { return copy((await this.workflow(id)).record); }
  async listWorkflows(): Promise<WorkflowRecord[]> { return (await this.store.listWorkflows()).map(w => copy(w.record)); }
  async getOperation(id: string): Promise<Operation> { return this.publicOperation(await this.operation(id)); }
  async getOperationFinality(id: string) {
    const op = await this.operation(id);
    if (op.mode !== 'live' || ACTIONS[op.kind][0] !== 'genlayer' || !op.operation.txHash || !this.chainGateway.nativeAppealStatus) return { supported: false, mode: op.mode, reason: 'A submitted live GenLayer transaction is required' };
    return { supported: true, mode: op.mode, transactionHash: op.operation.txHash, ...await this.chainGateway.nativeAppealStatus(op.operation.txHash) };
  }
  private publicOperation(stored:StoredOperation):Operation {const op=copy(stored.operation);if(stored.worker&&op.status!=='completed')delete op.intent;return op;}
  async getReputation(agent: string): Promise<unknown> { return this.chainGateway.getReputation(parse(AddressSchema,agent)); }
  prepareAcceptance(id: string, actor: string) { return this.issue(id,'accept',actor,{}); }
  prepareFunding(id: string, actor: string) { return this.issue(id,'fund',actor,{}); }
  publishHandoff(id: string, handoff: HandoffManifest, actor: string) { return this.issue(id,'handoff',actor,handoff); }
  acknowledgeHandoff(id: string, handoffId: string, actor: string) { return this.issue(id,'acknowledge',actor,{handoffId:parse(HashSchema,handoffId)}); }
  reportFailure(id: string, report: Report, actor: string) { return this.issue(id,'report',actor,report); }
  addEvidence(id: string, item: EvidenceItem, actor: string) { return this.issue(id,'evidence',actor,parse(EvidenceItemSchema,item)); }
  closeEvidence(id: string, actor: string) { return this.issue(id,'close_evidence',actor,{}); }
  requestAdjudication(id: string, actor: string) { return this.issue(id,'adjudicate',actor,{},true); }
  submitRepair(id: string, submission: RepairSubmission, actor: string) { return this.issue(id,'repair',actor,parse(RepairSubmissionSchema,submission)); }

  private async issue(id: string, kind: OperationKind, actor: string, input: unknown, worker = false): Promise<Operation> {
    actor = parse(AddressSchema,actor); parse(HashSchema,id);
    // Revision races are retried against fresh state. Failed checks never mutate stored data.
    for (let attempt=0; attempt<8; attempt++) {
      const w = await this.workflow(id); this.assertMode(w.record.mode);
      const scope = `${actor}:${id}:${kind}`, requestHash = hashCanonical({kind,input});
      const key = this.requestKeys.getStore() ?? hashCanonical({kind,input,round:w.record.evidenceRound ?? 0});
      const previous = await findIdempotentOperation(this.store,scope,key,requestHash); if (previous) return this.publicOperation(previous);
      const ops = await this.store.listOperations(id);
      this.validateAction(kind,w,actor,input,ops);
      let payload = copy(input);
      if (kind === 'adjudicate') {
        const snapshot = this.snapshot(w), hash = hashCanonical(snapshot), url = `${this.origin}/${hash}`;
        await this.store.putEvidence(Buffer.from(canonical(snapshot)),hash);
        w.snapshots.push({hash,url,snapshot}); w.currentSnapshotHash = hash;
        w.record.status = 'adjudicating'; payload = {snapshotHash:hash,snapshotUrl:url};
      }
      if (kind === 'repair') {
        const hash = hashCanonical(payload); await this.store.putEvidence(Buffer.from(canonical(payload)),hash);
      }
      const op = this.makeOperation(kind,w,actor,payload,worker);
      if (!worker) op.operation.intent = await this.prepareIntent(op,w);
      const expectedRevision = w.record.revision++;
      const c: ChangeSet = { workflow:{expectedRevision,value:w},operations:[{expectedRevision:null,value:op}],idempotency:{scope,key,requestHash,operationId:op.operation.id},outbox:[this.event(op,`operation.${op.operation.status}`)],jobs:worker?[this.job(op)]:[] };
      try { await this.store.commit(c); return copy(op.operation); }
      catch (error) { const saved = await this.idempotentAfterConflict(error,scope,key,requestHash); if (saved) return saved; if (!(error instanceof ProtocolError) || error.code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new ProtocolError('REVISION_CONFLICT','Concurrent workflow updates; retry the same request key');
  }

  async confirmOperation(operationId: string, txHash: string, actor: string): Promise<Operation> {
    const op = await this.operation(operationId); check(!op.worker,'WORKER_LEASE_REQUIRED','Worker operations require a current job lease');
    return this.confirm(operationId,txHash,actor);
  }
  /** Worker obtains a lease from Store.claimJob, then prepares using its configured EOA.
   * Persist the signed tx hash via recordJobSubmission before polling finality. Never re-sign
   * on retries when getOperation already contains a txHash. Signing stays in the worker.
   */
  async getJobCommand(lease: JobLease, actor: string): Promise<GatewayCommand> {
    actor = parse(AddressSchema,actor); const op = await this.operation(lease.operationId), w = await this.workflow(lease.workflowId);
    check(op.worker && op.operation.workflowId === lease.workflowId,'INVALID_JOB','Job operation does not match workflow');
    this.workerActor(op.kind,actor); this.assertMode(w.record.mode);
    await this.store.commit({lease:this.fence(lease)});
    return this.command({...op,actor},w);
  }
  async prepareJob(lease: JobLease, actor: string, materializedPayload?: unknown): Promise<{ operation: Operation; command: GatewayCommand; intent: TransactionIntent }> {
    actor = parse(AddressSchema,actor); const op = await this.operation(lease.operationId), w = await this.workflow(lease.workflowId);
    check(op.worker && op.operation.workflowId === lease.workflowId,'INVALID_JOB','Job operation does not match workflow');
    this.workerActor(op.kind,actor); this.assertMode(w.record.mode);
    check(!['completed','failed'].includes(op.operation.status),'INVALID_STATE','Job operation is already terminal');
    // Persist the exact intent once: refreshed chain nonce/authorization data must not replace a submitted intent.
    if (!op.operation.intent) {
      if (!CLEANUP.has(op.kind)) this.ensureOpen(w);
      if (op.kind === 'reserve') check(w.baseCaseOpened && this.now() >= Date.parse(w.cureDeadline!),'CURE_OPEN','Base case must be open and cure window must elapse before reserving');
      op.actor = actor;
      if (materializedPayload !== undefined) op.payload = copy(materializedPayload);
      op.operation.intent = await this.prepareIntent(op,w);
      const revision = op.revision++;
      await this.store.commit({ operations:[{expectedRevision:revision,value:op}],lease:this.fence(lease) });
    } else {
      if (materializedPayload !== undefined) check(hashCanonical(op.payload) === hashCanonical(materializedPayload),'INTENT_IMMUTABLE','Prepared worker payload cannot be replaced');
      check(op.actor === actor,'WRONG_SENDER','Worker wallet cannot change for a prepared operation');
      await this.store.commit({lease:this.fence(lease)});
    }
    return { operation:copy(op.operation),command:this.command(op,w),intent:copy(op.operation.intent) };
  }
  async recordJobSubmission(lease: JobLease, txHash: string, actor: string): Promise<Operation> {
    const op = await this.operation(lease.operationId); this.assertJob(op,lease,actor);
    parse(HashSchema,txHash); check(op.operation.intent,'INVALID_STATE','Prepare the worker intent before submitting');
    check(!op.operation.txHash || op.operation.txHash === txHash,'TRANSACTION_CONFLICT','Operation is already bound to another transaction');
    if (['completed','failed'].includes(op.operation.status)) return op.operation;
    const revision = op.revision++; op.operation.txHash = txHash; op.operation.status = 'submitted'; op.operation.updatedAt = this.iso();
    await this.store.commit({operations:[{expectedRevision:revision,value:op}],lease:this.fence(lease),outbox:[this.event(op,'operation.submitted')]});
    return copy(op.operation);
  }
  async confirmJob(lease: JobLease, txHash: string, actor: string): Promise<Operation> {
    const op = await this.operation(lease.operationId); this.assertJob(op,lease,actor);
    return this.confirm(op.operation.id,txHash,actor,lease);
  }
  async failJob(lease: JobLease, actor: string, code: string): Promise<void> {
    actor=parse(AddressSchema,actor);
    const op=await this.operation(lease.operationId);this.workerActor(op.kind,actor);
    check(op.worker && op.operation.workflowId===lease.workflowId,'INVALID_JOB','Job operation does not match workflow');
    // Materialization can fail before prepareJob records the worker as the intent owner.
    if(op.operation.intent)this.assertJob(op,lease,actor);
    else op.actor=actor;
    check(!['completed','failed'].includes(op.operation.status),'INVALID_STATE','Job operation is already terminal');
    const revision=op.revision++;op.operation.status='failed';
    op.operation.error={code,message:'Worker stopped this immutable operation; inspect its audit and transaction before recovery'};
    op.operation.updatedAt=this.iso();
    await this.store.commit({operations:[{expectedRevision:revision,value:op}],lease:{...this.fence(lease),complete:true},outbox:[this.event(op,'operation.failed')]});
  }
  async queueCleanup(id: string, kind: 'refund_escrow'|'withdraw'|'expire', actor: string, beneficiary?: string): Promise<Operation> {
    this.workerActor(kind,actor);
    for(let attempt=0;attempt<8;attempt++){
      const w=await this.workflow(id);this.assertMode(w.record.mode);
      if(kind==='withdraw') check(beneficiary && [...participants(w.record.manifest),...w.record.manifest.repairs.map(r=>r.recipient)].includes(beneficiary),'FORBIDDEN','Only an immutable beneficiary can receive a withdrawal');
      const op=this.makeOperation(kind,w,actor,kind==='withdraw'?{beneficiary}:{},true);
      const old=await this.store.getOperation(op.operation.id);if(old)return old.operation;
      const revision=w.record.revision++;
      try {await this.store.commit({workflow:{expectedRevision:revision,value:w},operations:[{expectedRevision:null,value:op}],jobs:[this.job(op)],outbox:[this.event(op,'operation.queued')]});return op.operation;}
      catch(error){if(!(error instanceof ProtocolError)||error.code!=='REVISION_CONFLICT')throw error;}
    }
    throw new ProtocolError('REVISION_CONFLICT','Retry cleanup');
  }
  /** Observe an already-executed withdrawal without replacing any caller's signed transaction. */
  async reconcileWithdrawal(id: string, txHash: string, beneficiary: string, actor: string): Promise<Operation | null> {
    this.workerActor('withdraw', parse(AddressSchema, actor));
    parse(HashSchema, txHash); beneficiary = parse(AddressSchema, beneficiary);
    check(this.chainGateway.getWithdrawalReceipt, 'UNSUPPORTED_OPERATION', 'Gateway cannot verify observed withdrawals');
    for (let attempt = 0; attempt < 8; attempt++) {
      const w = await this.workflow(id); this.assertMode(w.record.mode);
      check([...participants(w.record.manifest), ...w.record.manifest.repairs.map(r => r.recipient)].includes(beneficiary), 'FORBIDDEN', 'Only an immutable beneficiary can receive a withdrawal');
      const observed = await this.chainGateway.getWithdrawalReceipt(txHash, id, beneficiary);
      if (!observed) return null;
      const { receipt, intent } = observed;
      check(intent.chain === 'base' && intent.to === this.chainGateway.deployments.base.address && intent.chainId === BASE_CHAIN_ID && ['withdraw', 'withdrawFor'].includes(intent.functionName), 'RECEIPT_BINDING', 'Observed transaction must call the approved escrow withdrawal');
      check(hashCanonical(intent.args) === hashCanonical(intent.functionName === 'withdraw' ? [id] : [id, beneficiary]) && (intent.functionName !== 'withdraw' || receipt.from === beneficiary), 'RECEIPT_PAYLOAD', 'Withdrawal must bind the workflow and beneficiary');
      const op = this.makeOperation('withdraw', w, parse(AddressSchema, receipt.from), { beneficiary, observedTransaction: txHash }, true);
      const previous = await this.store.getOperation(op.operation.id);
      if (previous) return this.publicOperation(previous);
      this.validateReceipt(op, intent, receipt, txHash);
      check(receipt.finality === 'finalized' && receipt.execution === 'success', 'NOT_FINALIZED', 'Observed withdrawal must be successful and finalized');
      check([5, 6].includes(Number((receipt.result as any)?.state)), 'WITHDRAWAL_MISSING', 'Escrow must be released or refunded');
      const revision = w.record.revision++;
      await this.apply(op, w, receipt);
      w.receipts.push(copy(receipt));
      op.operation = { ...op.operation, intent: copy(intent), txHash, status: 'completed', result: copy(receipt.result) };
      try {
        await this.store.commit({ workflow: { expectedRevision: revision, value: w }, operations: [{ expectedRevision: null, value: op }], outbox: [this.event(op, 'operation.completed')] });
        return this.publicOperation(op);
      } catch (error) { if (!(error instanceof ProtocolError) || error.code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new ProtocolError('REVISION_CONFLICT', 'Retry withdrawal reconciliation');
  }
  private async confirm(id: string, txHash: string, actor: string, lease?: JobLease): Promise<Operation> {
    actor = parse(AddressSchema,actor); parse(HashSchema,txHash);
    for (let attempt=0; attempt<8; attempt++) {
      const op = await this.operation(id);
      check(op.actor === actor,'WRONG_SENDER','Only the intent owner may confirm this operation');
      check(!op.operation.txHash || op.operation.txHash === txHash,'TRANSACTION_CONFLICT','Operation already references another transaction');
      if (['completed','failed'].includes(op.operation.status)) return copy(op.operation);
      const intent = op.operation.intent; check(intent,'INVALID_STATE','Operation has no prepared transaction intent');
      const w = await this.workflow(op.operation.workflowId!); this.assertMode(w.record.mode);
      if (lease) this.assertJob(op,lease,actor);
      const receipt = await this.chainGateway.getReceipt(txHash,copy(intent));
      if (receipt) this.validateReceipt(op,intent,receipt,txHash);
      const oldOpRevision = op.revision++;
      op.operation.txHash = txHash; op.operation.updatedAt = this.iso();
      const c: ChangeSet = { operations:[{expectedRevision:oldOpRevision,value:op}],outbox:[],...(lease?{lease:this.fence(lease)}:{}) };
      if (!receipt || receipt.finality !== 'finalized' || receipt.execution === 'pending') {
        op.operation.status = 'confirming';
      } else if (receipt.execution !== 'success') {
        op.operation.status = 'failed'; op.operation.error = {code:receipt.execution === 'undetermined'?'CHAIN_UNDETERMINED':'TRANSACTION_REVERTED',message:'Chain execution did not succeed'};
        if (c.lease) c.lease.complete = true;
      } else {
        if (!CLEANUP.has(op.kind)) this.ensureOpen(w);
        const oldWorkflowRevision = w.record.revision++;
        const additional = await this.apply(op,w,receipt);
        w.receipts.push(copy(receipt));
        op.operation.status = 'completed'; op.operation.result = copy(receipt.result ?? {transactionHash:txHash});
        c.workflow = {expectedRevision:oldWorkflowRevision,value:w};
        c.operations!.push(...additional.map(value => ({expectedRevision:null,value})));
        c.jobs = additional.map(o => this.job(o));
        c.outbox!.push(...additional.map(o => this.event(o,'operation.queued')));
        if (c.lease) c.lease.complete = true;
      }
      c.outbox!.push(this.event(op,`operation.${op.operation.status}`));
      try { await this.store.commit(c); return copy(op.operation); }
      catch (error) { if (!(error instanceof ProtocolError) || error.code !== 'REVISION_CONFLICT') throw error; }
    }
    throw new ProtocolError('REVISION_CONFLICT','Concurrent confirmation; retry the same transaction');
  }

  private validateAction(kind: OperationKind, w: StoredWorkflow, actor: string, raw: unknown, ops: StoredOperation[], confirming = false): void {
    const r = w.record, m = r.manifest;
    this.ensureOpen(w);
    const isParticipant = participants(m).includes(actor), p = raw as Record<string,any>;
    check(isParticipant || (kind === 'repair' && m.repairs.some(x => x.recipient === actor)), 'FORBIDDEN','Wallet is not authorized for this workflow action');
    const inState = (...states: string[]) => check(states.includes(r.status),'INVALID_STATE',`Cannot ${kind} while workflow is ${r.status}`);
    const otherPending = (kinds: OperationKind[]) => !confirming && ops.some(o => pending(o) && kinds.includes(o.kind));
    switch (kind) {
      case 'accept':
        inState('funding'); check(!r.accepted.includes(actor),'ALREADY_ACCEPTED','Mandate already accepted'); break;
      case 'fund':
        inState('funding'); check(w.escrowReady,'ESCROW_NOT_READY','Escrow creation has not finalized');
        check(r.accepted.includes(actor),'NOT_ACCEPTED','Accept the mandate before funding'); check(!r.bonded[actor],'ALREADY_FUNDED','Bond already funded'); break;
      case 'handoff': {
        inState('active','suspended','decided','repairing');
        const h = this.validHandoff(m,raw,r.handoffs);
        check(h.producer === actor,'FORBIDDEN','Only the mandate producer may publish its handoff');
        if (r.status === 'active' || r.status === 'suspended') {
          check(!r.suspendedNodes.includes(h.nodeId),'NODE_SUSPENDED','Disputed node cannot produce a handoff');
          check(!w.activatedAt || this.now() < Date.parse(w.activatedAt) + m.nodes.find(n => n.id === h.nodeId)!.deadlineSeconds*1000,'MANDATE_EXPIRED','Mandate delivery deadline has passed');
        } else check(r.decision?.remedyId && this.now() < Date.parse(w.cureDeadline!) && this.decisionScope(w).includes(h.nodeId),'CURE_CLOSED','Cure handoff is outside its deadline or disputed path');
        check(!otherPending(['report']),'CASE_PENDING','A failure report is awaiting confirmation');
        for (const i of h.inputs) check(r.acknowledgments.some(a => a.handoffId === i.handoffId && a.agent === actor),'INPUT_NOT_ACKNOWLEDGED','Consumer must acknowledge every exact predecessor handoff before producing');
        check(!ops.some(o => pending(o) && o.kind === 'handoff' && (o.payload as HandoffManifest).nodeId === h.nodeId),'HANDOFF_PENDING','A handoff for this node is awaiting confirmation'); break;
      }
      case 'acknowledge': {
        inState('active','suspended','decided','repairing');
        if (r.status === 'decided' || r.status === 'repairing') check(this.now() < Date.parse(w.cureDeadline!),'CURE_CLOSED','Cure window has ended');
        const h = r.handoffs.find(h => h.id === p.handoffId);
        check(h,'HANDOFF_NOT_FOUND','Cannot acknowledge a missing handoff');
        check(m.nodes.some(n => n.agent === actor && n.dependencies.includes(h.nodeId)),'FORBIDDEN','Only a downstream consumer can acknowledge this handoff');
        const latest = r.handoffs.filter(x => x.nodeId === h.nodeId).at(-1);
        check(latest?.id === h.id,'STALE_INPUT','Only the latest predecessor handoff may be acknowledged');
        check(!r.acknowledgments.some(a => a.agent === actor && a.handoffId === h.id),'ALREADY_ACKNOWLEDGED','Handoff already acknowledged'); break;
      }
      case 'report':
        inState('active','suspended');
        check(!w.activatedAt || this.now() < Date.parse(w.activatedAt) + (Math.max(...m.nodes.map(n => n.deadlineSeconds)) + m.policy.reportWindowSeconds)*1000,'REPORT_EXPIRED','Failure reporting window has passed');
        check(!r.caseId && !otherPending(['report']),'CASE_EXISTS','Only one case is allowed per workflow');
        check(p && typeof p.nodeId === 'string' && typeof p.impact === 'string' && p.impact.length > 0 && p.impact.length <= 4000 && Object.keys(p).every(k => ['nodeId','impact'].includes(k)) && m.nodes.some(n => n.id === p.nodeId),'INVALID_REPORT','Report must name a mandate node and impact');
        check(!otherPending(['handoff']),'HANDOFF_PENDING','Confirm pending handoffs before freezing a failure report'); break;
      case 'evidence': {
        inState('evidence_open','needs_evidence'); check(this.now() < Date.parse(r.responseDeadline!),'EVIDENCE_EXPIRED','Evidence response deadline has passed');
        check(!otherPending(['close_evidence']),'EVIDENCE_CLOSING','Evidence closure is awaiting confirmation');
        const e = parse(EvidenceItemSchema,raw);
        check(e.submittedBy === actor && hashText(e.text) === e.hash,'EVIDENCE_HASH','Evidence must bind the submitting wallet and exact text bytes');
        check(!w.evidence.some(x => x.id === e.id || x.hash === e.hash) && !ops.some(o => pending(o) && o.kind === 'evidence' && ((o.payload as EvidenceItem).id === e.id || (o.payload as EvidenceItem).hash === e.hash)),'DUPLICATE_EVIDENCE','Evidence ID or content already exists');
        // Include pending submissions when enforcing the COMPLETE packet budget.
        const candidate = copy(w); candidate.evidence.push(...ops.filter(o => pending(o) && o.kind === 'evidence').map(o => o.payload as EvidenceItem),e);
        this.snapshot(candidate,false); break;
      }
      case 'close_evidence':
        inState('evidence_open','needs_evidence'); check(!w.closedBy.includes(actor),'ALREADY_CLOSED','Wallet already closed this round');
        check(!otherPending(['evidence']),'EVIDENCE_PENDING','Confirm pending evidence before closing'); break;
      case 'adjudicate':
        inState('evidence_open','needs_evidence');
        check(this.now() >= Date.parse(r.responseDeadline!) || participants(m).every(a => w.closedBy.includes(a)),'EVIDENCE_OPEN','Every participant must close early or the response deadline must pass');
        check(!otherPending(['evidence','close_evidence','adjudicate']),'EVIDENCE_PENDING','Confirm pending evidence operations first'); break;
      case 'repair': {
        inState('repairing'); check(this.now() >= Date.parse(w.cureDeadline!),'CURE_OPEN','Cure window has not elapsed'); check(w.reserved,'AWARD_NOT_RESERVED','Repair award reservation has not finalized');
        check(this.now() < Date.parse(r.repairDeadline!),'REPAIR_EXPIRED','Repair submission deadline has passed');
        check(!w.repair && !otherPending(['repair']),'REPAIR_EXISTS','Only one repair cycle is allowed');
        const s = parse(RepairSubmissionSchema,raw), remedy = m.repairs.find(x => x.id === r.decision?.remedyId);
        check(remedy && s.workflowId === m.id && s.caseId === r.caseId && s.remedyId === remedy.id && s.recipient === remedy.recipient && actor === remedy.recipient,'REPAIR_BINDING','Repair must bind the decided case, remedy and immutable recipient');
        const frozen = w.snapshots.find(x => x.hash === w.currentSnapshotHash)!;
        const old = new Map(frozen.snapshot.handoffs.map(h => [h.nodeId,h]));
        const previous = [...new Set(remedy.nodeIds.flatMap(n => old.has(n)?[old.get(n)!.artifact.hash]:[]))].sort();
        check(canonical([...s.previousHashes].sort()) === canonical(previous.length?previous:[r.hash]),'REPAIR_BINDING','Repair must bind the exact prior artifact hashes, or workflow hash for nondelivery');
        check(new Set(s.artifacts.map(a => a.hash)).size === s.artifacts.length && s.artifacts.every(a => s.evidence.some(e => e.hash === a.hash && Buffer.byteLength(e.text) === a.size)),'MISSING_REPAIR_TEXT','Every repair artifact requires complete matching text');
        check(new Set(s.evidence.map(e => e.id)).size === s.evidence.length && s.evidence.every(e => e.submittedBy === actor && hashText(e.text) === e.hash),'EVIDENCE_HASH','Repair evidence must bind the submitting wallet and exact text bytes');
        check(Buffer.byteLength(canonical({manifest:m,fundingReceipt:w.fundingReceipt ?? {},snapshot:frozen.snapshot,decision:r.decision,decisionId:hashCanonical(r.decision),repair:s,repairHash:hashCanonical(s)})) + 12000 <= 65_536,'EVIDENCE_TOO_LARGE','Complete repair judgment packet exceeds 64 KiB'); break;
      }
    }
  }

  private async apply(op: StoredOperation, w: StoredWorkflow, receipt: GatewayReceipt): Promise<StoredOperation[]> {
    const r = w.record, p = op.payload as Record<string,any>, result = receipt.result as Record<string,any> | undefined;
    const next: StoredOperation[] = [];
    const queue = (kind: OperationKind, payload: unknown = {}) => next.push(this.makeOperation(kind,w,r.manifest.creator,payload,true));
    const state = (...states: string[]) => check(states.includes(r.status),'INVALID_STATE','Finalized operation is incompatible with current workflow state');
    // A receipt confirms a particular payload; it never bypasses current state invariants.
    if (['accept','fund','handoff','acknowledge','report','evidence','close_evidence','repair'].includes(op.kind)) this.validateAction(op.kind,w,op.actor,op.payload,[],true);
    switch (op.kind) {
      case 'register': state('draft');
        if (result?.createdAt) r.createdAt = this.chainTime(result.createdAt);
        if (result?.expiresAt) r.expiresAt = this.chainTime(result.expiresAt);
        r.status = 'funding'; queue('provision_escrow'); break;
      case 'provision_escrow': state('funding'); w.escrowReady = true; break;
      case 'accept': r.accepted.push(op.actor); r.accepted.sort(); break;
      case 'fund':
        check(result?.amount === r.manifest.bonds[op.actor],'FUNDING_AMOUNT','Finalized bond amount differs from the accepted bond');
        r.bonded[op.actor] = result.amount; break;
      case 'activate_escrow':
        state('funding'); check(this.funded(w),'NOT_FUNDED','Every participant must accept and fully fund');
        queue('activate',{fundingReceipt:receipt}); break;
      case 'activate': state('funding'); check(this.funded(w),'NOT_FUNDED','Every participant must accept and fully fund');
        r.status = 'active'; w.activatedAt = result?.activatedAt ? this.chainTime(result.activatedAt) : this.iso();
        w.fundingReceipt = result?.fundingReceipt ?? p.fundingReceipt;
        if (result?.expiresAt) r.expiresAt = this.iso(Math.min(Date.parse(r.expiresAt),Date.parse(this.chainTime(result.expiresAt)))); break;
      case 'handoff': r.handoffs.push(copy(op.payload as HandoffManifest)); break;
      case 'acknowledge': r.acknowledgments.push({handoffId:p.handoffId,agent:op.actor,txHash:receipt.transactionHash}); break;
      case 'report':
        r.caseId = op.bindings.caseId; w.report = {...p,reporter:op.actor} as EvidenceSnapshot['report'];
        r.status = 'evidence_open'; r.evidenceRound = 1; r.responseDeadline = result?.responseDeadline ? this.chainTime(result.responseDeadline) : this.iso(Math.min(Date.parse(r.expiresAt),this.now()+r.manifest.policy.responseWindowSeconds*1000));
        r.suspendedNodes = descendants(r.manifest,[p.nodeId]); queue('open_case_escrow',{caseId:r.caseId}); break;
      case 'open_case_escrow': check(r.caseId === op.bindings.caseId,'RECEIPT_BINDING','Base case ID mismatch'); w.baseCaseOpened = true; break;
      case 'evidence': w.evidence.push(copy(op.payload as EvidenceItem)); w.closedBy = []; break;
      case 'close_evidence': w.closedBy.push(op.actor); break;
      case 'adjudicate': {
        state('adjudicating'); const frozen = w.snapshots.find(s => s.hash === op.bindings.snapshotHash);
        check(frozen && result?.decision,'DECISION_MISSING','A successful finalized chain judgment with a decision is required');
        const decision = this.validDecision(w,frozen.snapshot,result.decision);
        if (decision.outcome === 'DECIDED') check(canonical(decision.findings.map(f => f.nodeId).sort()) === canonical(this.decisionScope(w)),'DECISION_INCOMPLETE','DECIDED must cover the entire disputed dependency path');
        check(decision.outcome === 'NEEDS_EVIDENCE' ? decision.requestedEvidence.length > 0 : decision.requestedEvidence.length === 0,'INVALID_DECISION','Evidence requests must match the decision outcome');
        r.decision = decision;
        if (decision.outcome === 'NEEDS_EVIDENCE') {
          check(r.evidenceRound === 1,'EVIDENCE_ROUND_LIMIT','A third evidence round is not allowed');
          r.evidenceRound = 2; r.status = 'needs_evidence'; w.closedBy = [];
          r.responseDeadline = result?.responseDeadline ? this.chainTime(result.responseDeadline) : this.iso(Math.min(Date.parse(r.expiresAt),this.now()+r.manifest.policy.responseWindowSeconds*1000));
        } else if (decision.outcome === 'UNRESOLVED' || decision.findings.some(f => f.class === 'unresolved')) r.status = 'unresolved';
        else {
          r.status = 'decided';
          w.cureDeadline = result?.cureDeadline ? this.chainTime(result.cureDeadline) : this.iso(Math.min(Date.parse(r.expiresAt),this.now()+r.manifest.policy.cureWindowSeconds*1000));
          r.repairDeadline = result?.repairDeadline ? this.chainTime(result.repairDeadline) : this.iso(Math.min(Date.parse(r.expiresAt),Date.parse(w.cureDeadline)+r.manifest.policy.repairWindowSeconds*1000));
          if (decision.remedyId) queue('reserve',{decision,notBefore:Date.parse(w.cureDeadline!)});
        }
        break;
      }
      case 'reserve':
        state('decided'); check(r.decision?.outcome === 'DECIDED' && r.decision.remedyId && !r.decision.findings.some(f => f.class === 'unresolved'),'UNRESOLVED_AWARD','Only a finalized resolved decision can reserve an award');
        check(w.baseCaseOpened,'BASE_CASE_NOT_OPEN','Base case must be opened before reservation');
        w.reserved = true; r.status = 'repairing';
        if (result?.repairDeadline) r.repairDeadline = this.iso(Math.min(Date.parse(r.repairDeadline!),Date.parse(this.chainTime(result.repairDeadline)))); break;
      case 'repair': w.repair = copy(op.payload as RepairSubmission); w.repairHash = hashCanonical(op.payload); r.status = 'verifying_repair'; queue('verify_repair',{repairHash:w.repairHash}); break;
      case 'verify_repair':
        state('verifying_repair'); check(typeof result?.repairAccepted === 'boolean','REPAIR_JUDGMENT_MISSING','A separate successful finalized repair judgment is required');
        this.validateRepairVerdict(w,result); w.repairVerdictId = result.repairVerdictId;
        w.repairVerified = result.repairAccepted;
        if (result.repairAccepted) queue('release',{reservationDecisionId:hashCanonical(r.decision),reservationSnapshotHash:w.currentSnapshotHash,repairHash:w.repairHash,repairVerdictId:w.repairVerdictId}); else r.status = 'recovery_failed'; break;
      case 'release':
        state('verifying_repair'); this.validateReleasedRecovery(w,result);
        queue('payout',{beneficiary:r.manifest.repairs.find(x=>x.id===r.decision!.remedyId)!.recipient}); break;
      case 'payout': {
        this.validateRecoveryPayment(w,result);
        r.status = 'completed'; break;
      }
      case 'withdraw':
        check(result?.usdcTransferVerified===true && result.beneficiary===p.beneficiary && BigInt(result.withdrawnAmount??'0')>0n,'WITHDRAWAL_MISSING','Finalized withdrawal and matching USDC Transfer are required');
        if(w.repairVerified && r.manifest.repairs.some(x=>x.id===r.decision?.remedyId && x.recipient===p.beneficiary) && Number(result.state)===5){
          this.validateRecoveryPayment(w,result); r.status='completed';
        }
        break;
      case 'refund_escrow': check(Number(result?.state)===6,'REFUND_NOT_CONFIRMED','Escrow must be expired'); break;
      case 'expire':
        check(this.now() >= Date.parse(r.expiresAt),'NOT_EXPIRED','Hard lock has not elapsed');
        // A queued cleanup may confirm after payout or another terminal outcome.
        if (!CLOSED.has(r.status)) r.status = 'expired';
        break;
    }
    if ((op.kind === 'accept' || op.kind === 'fund' || op.kind === 'provision_escrow') && this.funded(w)) queue('activate_escrow');
    return next;
  }

  private snapshot(w: StoredWorkflow, requireSources = true): EvidenceSnapshot {
    check(w.report && w.record.caseId,'NO_CASE','Workflow has no failure case');
    const snapshot: EvidenceSnapshot = {schemaVersion:1,workflowId:w.record.manifest.id,workflowHash:w.record.hash,caseId:w.record.caseId,round:w.record.evidenceRound!,report:copy(w.report),handoffs:copy(w.record.handoffs),acknowledgments:copy(w.record.acknowledgments),evidence:copy(w.evidence)};
    // Manifest/funding are included by the native judge, outside the snapshot. Reserve
    // 12 KiB for the native rules/prompt framing, matching the chain's journal headroom.
    check(Buffer.byteLength(canonical({manifest:w.record.manifest,fundingReceipt:w.fundingReceipt ?? {},snapshot})) + 12000 <= 65_536,'EVIDENCE_TOO_LARGE','Complete adjudication packet exceeds 64 KiB');
    if (requireSources) {
      check(w.record.manifest.referenceHashes.every(hash => w.evidence.some(e => e.hash === hash)),'MISSING_REFERENCE_TEXT','Full committed reference text is required');
      for (const h of snapshot.handoffs) check(w.evidence.some(e => e.hash === h.artifact.hash && Buffer.byteLength(e.text) === h.artifact.size),'MISSING_ARTIFACT_TEXT','Full handoff artifact text is required');
    }
    try { return validateSnapshot(w.record.manifest,snapshot); } catch (error) { if (error instanceof ProtocolError) throw error; throw new ProtocolError('INVALID_EVIDENCE','Complete snapshot does not satisfy the protocol schema'); }
  }
  private makeOperation(kind: OperationKind, w: StoredWorkflow, actor: string, payload: unknown, worker: boolean): StoredOperation {
    const bindings: Bindings = {workflowId:w.record.manifest.id,workflowHash:w.record.hash};
    if (kind === 'report') bindings.caseId = hashCanonical({workflowId:w.record.manifest.id,workflowHash:w.record.hash,report:{...payload as object,reporter:actor}});
    else if (w.record.caseId) bindings.caseId = w.record.caseId;
    if (w.currentSnapshotHash) bindings.snapshotHash = w.currentSnapshotHash;
    if (w.record.decision) bindings.decisionHash = hashCanonical(w.record.decision);
    // New adjudication produces a new decision; it cannot be bound to the prior round's decision.
    if (kind === 'adjudicate') delete bindings.decisionHash;
    if (kind === 'release') { bindings.decisionHash = w.repairVerdictId; bindings.snapshotHash = w.repairHash; }
    if (kind === 'repair') bindings.repairHash = hashCanonical(payload);
    else if (w.repairHash) bindings.repairHash = w.repairHash;
    if (CLEANUP.has(kind)) { delete bindings.snapshotHash; delete bindings.decisionHash; delete bindings.repairHash; delete bindings.caseId; }
    const id = hashCanonical({kind,actor:worker?'worker':actor,payload,bindings,round:w.record.evidenceRound ?? 0});
    return {operation:{id,kind,status:worker?'queued':'awaiting_signature',workflowId:w.record.manifest.id,createdAt:this.iso(),updatedAt:this.iso()},kind,actor,payload:copy(payload),bindings,mode:w.record.mode,revision:0,worker};
  }
  private command(op: StoredOperation, w: StoredWorkflow): GatewayCommand {
    const payload = op.kind === 'repair' ? {submission:op.payload,repairUrl:`${this.origin}/${op.bindings.repairHash}`,repairHash:op.bindings.repairHash} : op.kind === 'report' ? {...op.payload as object,reporter:op.actor} : op.payload;
    return copy({kind:op.kind,actor:op.actor,workflow:w.record,payload,bindings:op.bindings});
  }
  private async prepareIntent(op: StoredOperation, w: StoredWorkflow): Promise<TransactionIntent> {
    this.assertMode(w.record.mode);
    const intent = await this.chainGateway.prepare(this.command(op,w));
    const [chain,functionName] = ACTIONS[op.kind], deployment = this.chainGateway.deployments[chain];
    check(intent.chain === chain && intent.functionName === functionName && intent.chainId === deployment.chainId && parse(AddressSchema,intent.to) === parse(AddressSchema,deployment.address) && Array.isArray(intent.args),'INVALID_INTENT','Gateway intent does not match the operation and deployment');
    check((intent.value ?? '0') === '0','UNEXPECTED_VALUE','Faultline intents cannot send native funds');
    canonical(intent.args); return copy({...intent,to:intent.to.toLowerCase()});
  }
  private validateReceipt(op: StoredOperation, intent: TransactionIntent, r: GatewayReceipt, txHash: string): void {
    const deployment = this.chainGateway.deployments[intent.chain];
    check(r.transactionHash === txHash && r.chain === intent.chain && r.chainId === intent.chainId && parse(AddressSchema,r.to) === intent.to && parse(AddressSchema,r.from) === op.actor,'RECEIPT_BINDING','Receipt transaction, sender, target or chain does not match intent');
    check(r.functionName === intent.functionName && r.argsHash === hashCanonical(intent.args) && r.value === (intent.value ?? '0'),'RECEIPT_PAYLOAD','Receipt does not execute the prepared arguments and value');
    check(r.deploymentHash === deployment.codeHash,'DEPLOYMENT_MISMATCH','Receipt was executed against a different deployment');
    for (const [key,value] of Object.entries(op.bindings)) check(r[key as keyof Bindings] === value,'RECEIPT_BINDING',`Receipt does not bind ${key}`);
    check(['success','reverted','pending','undetermined'].includes(r.execution) && ['pending','finalized'].includes(r.finality),'INVALID_RECEIPT','Unknown receipt execution or finality status');
    if (r.finality === 'finalized') {
      check(/^0x[0-9a-f]{64}$/.test(r.blockHash) && r.blockHash !== `0x${'0'.repeat(64)}` && /^[1-9][0-9]*$/.test(r.blockNumber),'INVALID_BLOCK','A real included block is required for finalized receipts');
    }
  }
  private assertMode(mode: Mode): void {
    check(mode === 'live' || mode === 'replay','INVALID_MODE','Mode must be live or replay');
    check(this.chainGateway.mode === mode,'GATEWAY_MODE','Live and replay gateways cannot be mixed');
    if (mode === 'live') {
      check(this.store.durability === 'durable','MEMORY_LIVE_FORBIDDEN','Live workflows require durable MongoDB storage');
      for (const [chain,chainId] of [['base',BASE_CHAIN_ID],['genlayer',GENLAYER_CHAIN_ID]] as const) {
        const d = this.chainGateway.deployments[chain];
        check(d && d.verified === true && d.chainId === chainId && /^0x[0-9a-f]{64}$/.test(d.codeHash) && d.codeHash !== `0x${'0'.repeat(64)}` && /^0x[0-9a-fA-F]{40}$/.test(d.address) && !/^0x0{40}$/.test(d.address),'LIVE_DEPLOYMENT_REQUIRED','Verified testnet deployment evidence is required');
      }
    }
  }
  private ensureOpen(w: StoredWorkflow, allowExpiry = false) {
    check(!CLOSED.has(w.record.status),'INVALID_STATE','Workflow is terminal');
    check(allowExpiry || this.now() < Date.parse(w.record.expiresAt),'WORKFLOW_EXPIRED','Hard lock has elapsed; no late signatures can advance this workflow');
  }
  private chainTime(value: unknown): string {
    check((typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)),'INVALID_CHAIN_TIME','Chain time must be positive Unix seconds');
    const seconds = Number(value); check(Number.isSafeInteger(seconds) && seconds < 8_640_000_000_000,'INVALID_CHAIN_TIME','Chain timestamp is out of range');
    return this.iso(seconds*1000);
  }
  private decisionScope(w: StoredWorkflow): string[] {
    const m = w.record.manifest, root = w.report!.nodeId, all = new Set(descendants(m,[root])), ancestors = new Set([root]);
    for (let i=0;i<m.nodes.length;i++) for (const n of m.nodes) if (ancestors.has(n.id)) for (const dep of n.dependencies) ancestors.add(dep);
    return [...new Set([...all,...ancestors])].sort();
  }
  private validateRepairVerdict(w: StoredWorkflow, result: Record<string,any>): void {
    const v = result.repairVerdict;
    check(v && v.schemaVersion === 1 && v.workflowId === w.record.manifest.id && v.caseId === w.record.caseId && v.decisionId === hashCanonical(w.record.decision) && v.repairHash === w.repairHash && v.remedyId === w.record.decision!.remedyId && v.accepted === result.repairAccepted && result.repairVerdictId === hashCanonical(v),'REPAIR_JUDGMENT_BINDING','Repair verdict must bind the original decision, immutable repair, and verdict hash');
  }
  private validateReleasedRecovery(w: StoredWorkflow, result: Record<string,any> | undefined): void {
    const remedy=w.record.manifest.repairs.find(x=>x.id===w.record.decision?.remedyId);
    check(w.repairVerified && w.reserved && remedy,'REPAIR_NOT_VERIFIED','Repair payout requires a finalized accepted repair and reservation');
    check(Number(result?.state)===5 && result?.remedyId===hashText(remedy.id) && result.repairDecisionId===w.repairVerdictId && result.repairHash===w.repairHash && result.reservationDecisionId===hashCanonical(w.record.decision) && result.reservationSnapshotHash===w.currentSnapshotHash,'RELEASE_NOT_CONFIRMED','Released escrow must bind the reserved judgment and accepted repair');
  }
  private validateRecoveryPayment(w: StoredWorkflow, result: Record<string,any> | undefined): void {
    this.validateReleasedRecovery(w,result);
    const remedy=w.record.manifest.repairs.find(x=>x.id===w.record.decision!.remedyId)!;
    check(result?.usdcTransferVerified===true && result.beneficiary===remedy.recipient && BigInt(result.withdrawnAmount??'0')>=BigInt(remedy.price),'PAYOUT_NOT_CONFIRMED','Finalized withdrawal must include the matching USDC Transfer to the fixed repair beneficiary');
  }
  private funded(w: StoredWorkflow) { return w.escrowReady && participants(w.record.manifest).every(a => w.record.accepted.includes(a) && w.record.bonded[a] === w.record.manifest.bonds[a]); }
  private workerActor(kind: OperationKind, actor: string) {
    check(WORKER_KINDS.has(kind),'INVALID_JOB','Operation is not a worker action');
    const configured = this.options.workerActors?.[ACTIONS[kind][0]];
    check(configured && parse(AddressSchema,configured) === actor,'WORKER_FORBIDDEN','Worker wallet is not configured for this chain');
  }
  private assertJob(op: StoredOperation, lease: JobLease, actor: string) { this.workerActor(op.kind,parse(AddressSchema,actor)); check(op.worker && op.operation.id === lease.operationId && op.operation.workflowId === lease.workflowId && op.actor === actor.toLowerCase(),'INVALID_JOB','Job operation, workflow or worker does not match'); }
  private fence(lease: JobLease): NonNullable<ChangeSet['lease']> { return {id:lease.id,owner:lease.leaseOwner,token:lease.leaseToken,now:this.now()}; }
  private job(op: StoredOperation): DurableJob { return {id:hashCanonical({operationId:op.operation.id,kind:'job'}),workflowId:op.operation.workflowId!,operationId:op.operation.id,kind:op.kind,state:'queued',availableAt:op.kind === 'reserve' ? (op.payload as {notBefore:number}).notBefore : this.now(),attempts:0,revision:0}; }
  private event(op: StoredOperation, type: string): OutboxEvent { return {id:hashCanonical({operationId:op.operation.id,type,revision:op.revision}),workflowId:op.operation.workflowId!,operationId:op.operation.id,type,createdAt:this.now(),payload:{operation:this.publicOperation(op)}}; }
  private async workflow(id: string) { parse(HashSchema,id); const w = await this.store.getWorkflow(id); check(w,'NOT_FOUND','Workflow not found'); return w; }
  private async operation(id: string) { parse(HashSchema,id); const op = await this.store.getOperation(id); check(op,'NOT_FOUND','Operation not found'); return op; }
  private iso(now = this.now()) { return new Date(now).toISOString(); }
  private validManifest(input: unknown) { try { return validateWorkflow(input); } catch(error) { if(error instanceof ProtocolError) throw error; throw new ProtocolError('INVALID_MANIFEST','Manifest does not match the protocol schema'); } }
  private validHandoff(m: WorkflowManifest, input: unknown, previous: HandoffManifest[]) { try { return validateHandoff(m,input,previous); } catch(error) { if(error instanceof ProtocolError) throw error; throw new ProtocolError('INVALID_HANDOFF','Handoff does not match the protocol schema'); } }
  private validDecision(w: StoredWorkflow, snapshot: EvidenceSnapshot, input: unknown) { try { return validateDecision(w.record.manifest,snapshot,input); } catch(error) { if(error instanceof ProtocolError) throw error; throw new ProtocolError('INVALID_DECISION','Finalized decision does not match the protocol schema'); } }
  private async idempotentAfterConflict(error: unknown, scope: string, key: string, hash: string): Promise<Operation | null> {
    if (!(error instanceof ProtocolError) || !['REVISION_CONFLICT','IDEMPOTENCY_CONFLICT'].includes(error.code)) throw error;
    const previous=await findIdempotentOperation(this.store,scope,key,hash);
    return previous?this.publicOperation(previous):null;
  }
  async exportAudit(id: string) {
    const w = await this.workflow(id);
    return {schemaVersion:1,mode:w.record.mode,workflow:copy(w.record),evidence:copy(w.evidence),snapshots:copy(w.snapshots),receipts:copy(w.receipts),repair:copy(w.repair ?? null),operations:(await this.store.listOperations(id)).map(o => this.publicOperation(o)),trust:{bridge:'single trusted attestor',responsibility:'GenLayer successful finalized consensus only',protocolFees:'0',replay:w.record.mode === 'replay'}};
  }
}
