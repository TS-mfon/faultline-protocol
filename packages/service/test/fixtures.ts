import { hashCanonical, hashText, DEFAULT_POLICY, type WorkflowManifest, type TransactionIntent, type Operation, type RepairSubmission } from '@faultline/protocol';
import { FaultlineService, MemoryStore, type ChainGateway, type GatewayCommand, type GatewayReceipt, type JobLease } from '../src';
export const addr = (n: number) => `0x${n.toString(16).padStart(40,'0')}`;
export const A = addr(1), B = addr(2), R = addr(3), WORKER = addr(9);
export function manifest(seed = 'service-workflow'): WorkflowManifest {
  return {schemaVersion:1,id:hashText(seed),title:'Unit-correct report',domain:'research',creator:A,nodes:[
    {id:'measure',version:1,agent:A,title:'Measurement',specification:'Publish measured latency in milliseconds',dependencies:[],duties:[{id:'units',description:'Declare the measured units'}],exceptions:[],deadlineSeconds:3600},
    {id:'report',version:1,agent:B,title:'Report',specification:'Validate and publish the measurement',dependencies:['measure'],duties:[{id:'check',description:'Check upstream units'}],exceptions:[],deadlineSeconds:7200},
  ],bonds:{[A]:'1000000',[B]:'1000000'},repairCap:'1000000',repairs:[{id:'correct',recipient:R,price:'750000',scope:'Correct the measurement and report',nodeIds:['measure','report']}],referenceHashes:[],policy:{...DEFAULT_POLICY}};
}
const functions: Record<string,[TransactionIntent['chain'],string]> = {
  register:['genlayer','register_workflow'],provision_escrow:['base','createWorkflow'],accept:['genlayer','accept_mandate'],fund:['base','depositBond'],activate_escrow:['base','activateWorkflow'],activate:['genlayer','activate_workflow'],handoff:['genlayer','record_handoff'],acknowledge:['genlayer','acknowledge_handoff'],report:['genlayer','open_case'],open_case_escrow:['base','openCase'],evidence:['genlayer','submit_evidence'],close_evidence:['genlayer','close_evidence'],adjudicate:['genlayer','adjudicate'],reserve:['base','reserveAward'],repair:['genlayer','submit_repair'],verify_repair:['genlayer','verify_repair'],release:['base','releaseRepair'],payout:['base','withdrawFor'],withdraw:['base','withdrawFor'],refund_escrow:['base','refundExpired'],expire:['genlayer','expire_workflow'],
};
/** Deliberately synthetic. This class is confined to tests and advertises replay. */
export class FixtureGateway implements ChainGateway {
  readonly mode = 'replay' as const;
  readonly deployments = {base:{chainId:84532,address:addr(40),codeHash:hashText('base fixture'),verified:false},genlayer:{chainId:4221,address:addr(41),codeHash:hashText('genlayer fixture'),verified:false}};
  receipts = new Map<string,GatewayReceipt>();
  prepareCount = 0;
  async prepare(c: GatewayCommand): Promise<TransactionIntent> {
    this.prepareCount++;
    const [chain,functionName] = functions[c.kind]!;
    return {chain,functionName,chainId:this.deployments[chain].chainId,to:this.deployments[chain].address,args:[c.workflow.manifest.id,c.payload],value:'0'};
  }
  async getReceipt(hash: string) { return this.receipts.get(hash) ?? null; }
  async getReputation(agent: string) { return {mode:'replay',agent}; }
}
export function setup(m = manifest()) {
  let now = Date.parse('2026-10-15T00:00:00Z');
  const store = new MemoryStore({purpose:'test'}), gateway = new FixtureGateway();
  const options = {evidenceOrigin:'https://evidence.example.test/api/evidence',now:()=>now,workerActors:{base:WORKER,genlayer:WORKER}};
  const service = new FaultlineService(store,gateway,options);
  const ctx = {m,store,gateway,service,options,now:()=>now,advance:(ms: number)=>{now+=ms;},
    async receipt(operation: Operation, result?: unknown, overrides: Partial<GatewayReceipt> = {}) {
      const stored = (await store.getOperation(operation.id))!, intent = stored.operation.intent!;
      const transactionHash = hashText(`fixture-tx:${operation.id}`);
      const receipt: GatewayReceipt = {transactionHash,chain:intent.chain,chainId:intent.chainId,to:intent.to,from:stored.actor,functionName:intent.functionName,argsHash:hashCanonical(intent.args),value:'0',deploymentHash:gateway.deployments[intent.chain].codeHash,blockHash:hashText('fixture-block'),blockNumber:'12',execution:'success',finality:'finalized',...stored.bindings,...(result===undefined?{}:{result}),...overrides};
      gateway.receipts.set(transactionHash,receipt); return transactionHash;
    },
    async confirm(operation: Operation, result?: unknown) {
      const op = (await store.getOperation(operation.id))!;
      return service.confirmOperation(operation.id,await ctx.receipt(operation,result),op.actor);
    },
    async claim(kind: string): Promise<JobLease> {
      const lease = await store.claimJob('fixture-worker',now,60_000);
      if (!lease || lease.kind !== kind) throw new Error(`Expected ${kind}, got ${lease?.kind}`);
      return lease;
    },
    async job(kind: string, result?: unknown) {
      const lease = await ctx.claim(kind);
      const {operation} = await service.prepareJob(lease,WORKER);
      const hash = await ctx.receipt(operation,result);
      await service.recordJobSubmission(lease,hash,WORKER);
      return service.confirmJob(lease,hash,WORKER);
    },
    async active() {
      await ctx.confirm(await service.createWorkflow(m,A,'replay')); await ctx.job('provision_escrow');
      for (const a of [A,B]) { await ctx.confirm(await service.prepareAcceptance(m.id,a)); await ctx.confirm(await service.prepareFunding(m.id,a),{amount:m.bonds[a]}); }
      await ctx.job('activate_escrow'); await ctx.job('activate');
    },
    async evidenceOpen() {
      await ctx.active(); await ctx.confirm(await service.reportFailure(m.id,{nodeId:'report',impact:'Published seconds as milliseconds'},B));
      await ctx.job('open_case_escrow');
      const text = 'Measurement claimed 1000 ms; source observation was one millisecond.';
      await ctx.confirm(await service.addEvidence(m.id,{id:'source',text,hash:hashText(text),submittedBy:A},A));
    },
    async adjudicating() {
      await ctx.evidenceOpen(); for (const a of [A,B]) await ctx.confirm(await service.closeEvidence(m.id,a));
      return service.requestAdjudication(m.id,A);
    },
    async decision(outcome: 'DECIDED'|'NEEDS_EVIDENCE'|'UNRESOLVED' = 'DECIDED') {
      const w = (await store.getWorkflow(m.id))!;
      return {schemaVersion:1,workflowId:m.id,caseId:w.record.caseId,snapshotHash:w.currentSnapshotHash,outcome,findings:outcome==='DECIDED'?[
        {nodeId:'measure',class:'primary',dutyIds:['units'],evidenceRefs:['source'],reason:'Published incorrect units'},
        {nodeId:'report',class:'contributory',dutyIds:['check'],evidenceRefs:['source'],reason:'Skipped the agreed unit validation'},
      ]:[],edges:[],remedyId:outcome==='DECIDED'?'correct':null,requestedEvidence:outcome==='NEEDS_EVIDENCE'?['Provide the original measurement']:[],rationale:'Fixture only'};
    },
  }; return ctx;
}

/** Authored receipts for local service tests only; no network adjudication or payout. */
export async function recoveryReady() {
  const c=setup();await c.adjudicating();await c.job('adjudicate',{decision:await c.decision()});
  c.advance(86400000);await c.job('reserve');
  const w=await c.service.getWorkflow(c.m.id),text='Fixture corrected output';
  const submission:RepairSubmission={schemaVersion:1,workflowId:c.m.id,caseId:w.caseId!,remedyId:'correct',recipient:R,artifacts:[{hash:hashText(text),uri:'https://example.test/fixed',mediaType:'text/plain',size:Buffer.byteLength(text)}],evidence:[{id:'fixed',text,hash:hashText(text),submittedBy:R}],previousHashes:[w.hash]};
  await c.confirm(await c.service.submitRepair(c.m.id,submission,R));
  const verdict={schemaVersion:1,workflowId:c.m.id,caseId:w.caseId!,decisionId:hashCanonical(w.decision),repairHash:hashCanonical(submission),remedyId:'correct',accepted:true,checks:[{nodeId:'measure',satisfied:true},{nodeId:'report',satisfied:true}],evidenceRefs:['fixed'],rationale:'Fixture only'};
  await c.job('verify_repair',{repairAccepted:true,repairVerdict:verdict,repairVerdictId:hashCanonical(verdict)});
  const released={state:5,remedyId:hashText('correct'),reservationDecisionId:hashCanonical(w.decision),reservationSnapshotHash:w.decision!.snapshotHash,repairDecisionId:hashCanonical(verdict),repairHash:hashCanonical(submission)};
  return {c,released};
}
