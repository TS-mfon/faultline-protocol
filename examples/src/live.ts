import {hashCanonical,hashText,ProtocolError,type Operation,type RepairSubmission} from '@faultline/protocol';
import type {FaultlineClient} from '@faultline/sdk';
import {handoff,makeManifest,scenarios,type Actors,type Domain} from './scenarios';
import type {TaskOutput,TaskRequest} from './tasks';
export interface RunState {schemaVersion:2;mode:'live';domain:Domain;runId:string;manifest:ReturnType<typeof makeManifest>;operations:Record<string,{id:string;txHash?:string}>;work:Record<string,{state:'running'|'complete';output?:TaskOutput}>;outcome?:string;}
export interface LiveDependencies {state:RunState;save():Promise<void>;client(actor:string):Promise<FaultlineClient>;sign(actor:string,operation:Operation):Promise<string|null>;fundApproval(actor:string,amount:string):Promise<boolean>;task(input:TaskRequest):Promise<TaskOutput>;evidenceOrigin:string;recordAdjudication?(audit:any):Promise<void>;verifyAudit(audit:any):Promise<unknown>;}
export function initialState(domain:Domain,actors:Actors,runId:string):RunState{return {schemaVersion:2,mode:'live',domain,runId,manifest:makeManifest(domain,actors,runId),operations:{},work:{}};}
/** One bounded tick. Pending consensus/windows stop progress without changing application clocks. */
export async function runTick(d:LiveDependencies):Promise<{stage:string;complete:boolean;verification?:unknown}> {
 const {state:s}=d,m=s.manifest,scenario=scenarios[s.domain],creator=await d.client(m.creator);
 const pending=(stage:string)=>({stage,complete:false});
 async function operation(key:string,actor:string,create:(client:FaultlineClient,key:string)=>Promise<Operation>):Promise<boolean>{
  const client=await d.client(actor),saved=s.operations[key];let op=saved?await client.getOperation(saved.id):await create(client,`${m.id}:${key}`);
  if(!saved){s.operations[key]={id:op.id};await d.save();}
  if(op.status==='failed')throw new ProtocolError(op.error?.code??'OPERATION_FAILED',`Stopped ${key}: ${op.error?.message??'failed'}`);
  if(op.status==='completed')return true;
  if(op.status==='queued')return false;
  let hash=op.txHash??s.operations[key].txHash;
  if(!hash){if(op.status!=='awaiting_signature'||!op.intent)return false;hash=await d.sign(actor,op)??undefined;if(!hash)return false;s.operations[key].txHash=hash;await d.save();}
  op=await client.confirmOperation(op.id,hash,{idempotencyKey:`confirm-${op.id}`});
  if(op.status==='failed')throw new Error(`Operation ${key} failed; inspect ${op.id}`);
  return op.status==='completed';
 }
 async function work(input:TaskRequest):Promise<string>{
  const saved=s.work[input.task];if(saved?.state==='complete'){
   if(!saved.output||saved.output.inputHash!==hashCanonical(input)||saved.output.outputHash!==hashText(saved.output.text))throw new Error('Saved task input or output changed');
   return saved.output.text;
  }
  // These keyless tasks are deterministic and have no external effects, so interrupted work can repeat.
  s.work[input.task]={state:'running'};await d.save();
  const output=await d.task(input);s.work[input.task]={state:'complete',output};await d.save();return output.text;
 }
 await creator.putArtifact(scenario.source,{idempotencyKey:`source-${m.id}`});
 if(!await operation('register',m.creator,(c,k)=>c.createWorkflow(m,{idempotencyKey:k})))return pending('register-finality');
 const audit=await creator.audit(m.id);
 if(!audit.operations.some((o:Operation)=>o.kind==='provision_escrow'&&o.status==='completed'))return pending('worker-provision-escrow');
 for(const n of m.nodes){
  if(!await operation(`accept-${n.id}`,n.agent,(c,k)=>c.accept(m.id,{idempotencyKey:k})))return pending(`accept-${n.id}-finality`);
  if(!s.operations[`fund-${n.id}`]&&!await d.fundApproval(n.agent,m.bonds[n.agent]))return pending(`approve-${n.id}-finality`);
  if(!await operation(`fund-${n.id}`,n.agent,(c,k)=>c.fund(m.id,{idempotencyKey:k})))return pending(`fund-${n.id}-finality`);
 }
 let workflow=await creator.getWorkflow(m.id);
 if(['draft','funding'].includes(workflow.status))return pending('worker-activation');
 const artifacts:string[]=[],handoffs:ReturnType<typeof handoff>[]=[];
 for(let i=0;i<3;i++){
  const n=m.nodes[i];
  if(i&&!await operation(`ack-${n.id}`,n.agent,(c,k)=>c.acknowledge(m.id,handoffs[i-1].id,{idempotencyKey:k})))return pending(`ack-${n.id}-finality`);
  const text=await work({domain:s.domain,task:n.id as TaskRequest['task'],source:scenario.source,...(i?{upstream:artifacts[i-1]}:{})});
  await (await d.client(n.agent)).putArtifact(text,{idempotencyKey:`blob-${hashText(text)}`});
  artifacts.push(text);const h=handoff(m,i,text,handoffs,d.evidenceOrigin);handoffs.push(h);
  if(!await operation(`handoff-${n.id}`,n.agent,(c,k)=>c.publishHandoff(m.id,h,{idempotencyKey:k})))return pending(`handoff-${n.id}-finality`);
 }
 if(!await operation('report',m.creator,(c,k)=>c.reportFailure(m.id,{nodeId:'publish',impact:'Check the published result against the committed source. Determine whether the original calculation and required independent review were performed; assess only the agreed duties.'},{idempotencyKey:k})))return pending('report-finality');
 for(const [index,text] of [scenario.source,...artifacts].entries()){
  const evidence={id:index?'artifact-'+(index-1):'reference',hash:hashText(text),text,submittedBy:m.creator};
  if(!await operation(`evidence-${index}`,m.creator,(c,k)=>c.addEvidence(m.id,evidence,{idempotencyKey:k})))return pending(`evidence-${index}-finality`);
 }
 for(const n of m.nodes)if(!await operation(`close-${n.id}`,n.agent,(c,k)=>c.closeEvidence(m.id,{idempotencyKey:k})))return pending(`close-${n.id}-finality`);
 // Worker owns this operation. Polling it does not grant the caller authority to sign it.
 const adjudication=s.operations.adjudicate;
 if(!adjudication){const op=await creator.adjudicate(m.id,{idempotencyKey:`${m.id}:adjudicate`});s.operations.adjudicate={id:op.id};await d.save();return pending('consensus');}
 const judge=await creator.getOperation(adjudication.id);
 if(judge.status==='failed'||judge.status==='completed')await d.recordAdjudication?.(await creator.audit(m.id));
 if(judge.status==='failed')throw new Error(`Adjudication failed: ${judge.error?.code}`);
 if(judge.status!=='completed')return pending('consensus');
 workflow=await creator.getWorkflow(m.id);
 if(['needs_evidence','unresolved','recovery_failed','expired'].includes(workflow.status)){s.outcome=workflow.status;await d.save();return pending(workflow.status);}
 if(workflow.status==='decided')return pending('cure-window-and-reservation');
 const remedy=m.repairs.find(r=>r.id===workflow.decision?.remedyId);
 if(!remedy){s.outcome='no-repair-awarded';await d.save();return pending('no-repair-awarded');}
 if(!s.operations.repair&&workflow.status!=='repairing')return pending('reservation');
 const repairText=await work({domain:s.domain,task:'repair',source:scenario.source});
 const repairHash=hashText(repairText);
 await (await d.client(remedy.recipient)).putArtifact(repairText,{idempotencyKey:`blob-${repairHash}`});
 const repair:RepairSubmission={schemaVersion:1,workflowId:m.id,caseId:workflow.caseId!,remedyId:remedy.id,recipient:remedy.recipient,artifacts:[{hash:repairHash,uri:`${d.evidenceOrigin}/${repairHash}`,mediaType:'text/plain',size:Buffer.byteLength(repairText)}],evidence:[{id:'repair-result',hash:repairHash,text:repairText,submittedBy:remedy.recipient}],previousHashes:handoffs.filter(h=>remedy.nodeIds.includes(h.nodeId)).map(h=>h.artifact.hash)};
 if(!await operation('repair',remedy.recipient,(c,k)=>c.submitRepair(m.id,repair,{idempotencyKey:k})))return pending('repair-submission-finality');
 workflow=await creator.getWorkflow(m.id);
 if(workflow.status!=='completed')return pending(workflow.status==='recovery_failed'?'repair-rejected':'repair-consensus-and-usdc-transfer');
 const finalAudit=await creator.audit(m.id),verification=await d.verifyAudit(finalAudit);
 s.outcome='completed-with-finalized-payment';await d.save();return {stage:s.outcome,complete:true,verification};
}
