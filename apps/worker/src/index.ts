import type { FaultlineService, GatewayCommand, Store } from '@faultline/service';
import { ProtocolError, type TransactionIntent } from '@faultline/protocol';
export { materialize, confirmed } from './attestor';
export { DurableSigner, MongoSigningJournal, journalOnce } from './signer';
export interface WorkerDependencies {service:FaultlineService;store:Store;actor:string;owner:string;materialize(command:GatewayCommand):Promise<unknown>;submit(id:string,intent:TransactionIntent):Promise<string|null>;now?:()=>number;}
export async function runOne(deps:WorkerDependencies):Promise<'idle'|'completed'|'pending'>{
  const now=deps.now??Date.now;const lease=await deps.store.claimJob(deps.owner,now(),120_000);if(!lease)return 'idle';
  // A heartbeat keeps RPC/signing work fenced. A failed heartbeat prevents any new signing.
  let lost:unknown;
  const timer=setInterval(()=>{deps.store.renewLease(lease.id,lease.leaseOwner,lease.leaseToken,now(),120_000).catch(e=>{lost=e;});},30_000);
  try{
    const stored=await deps.store.getOperation(lease.operationId);if(!stored)throw new ProtocolError('NOT_FOUND','Job operation is missing');let op=stored.operation;
    if(!op.intent&&['payout','withdraw'].includes(stored.kind)){
      const workflow=await deps.store.getWorkflow(lease.workflowId),beneficiary=(stored.payload as {beneficiary:string}).beneficiary;
      if(workflow?.receipts.some(receipt=>['withdraw','withdrawFor'].includes(receipt.functionName)&&receipt.finality==='finalized'&&receipt.execution==='success'&&(receipt.result as any)?.beneficiary===beneficiary&&(receipt.result as any)?.usdcTransferVerified===true)){
        await deps.service.failJob(lease,deps.actor,'WITHDRAWAL_RECONCILED');return 'completed';
      }
    }
    if(!op.intent){const command=await deps.service.getJobCommand(lease,deps.actor);const payload=await deps.materialize(command);if(lost)throw lost;op=(await deps.service.prepareJob(lease,deps.actor,payload)).operation;}
    if(!op.txHash){if(lost)throw lost;await deps.store.renewLease(lease.id,lease.leaseOwner,lease.leaseToken,now(),120_000);const hash=await deps.submit(op.id,op.intent!);if(!hash){await deps.store.retryJob(lease.id,lease.leaseOwner,lease.leaseToken,now(),now()+30_000);return 'pending';}op=await deps.service.recordJobSubmission(lease,hash,deps.actor);}
    const result=await deps.service.confirmJob(lease,op.txHash!,deps.actor);
    if(['completed','failed'].includes(result.status))return 'completed';
    await deps.store.retryJob(lease.id,lease.leaseOwner,lease.leaseToken,now(),now()+30_000);return 'pending';
  }catch(error){
    if(!lost && error instanceof ProtocolError && ['TRANSACTION_REVERTED','CONSENSUS_EVENT_MISSING','WORKFLOW_EXPIRED','CHAIN_FAILURE','EXECUTION_FAILED','INTENT_IMMUTABLE','TERMS_BINDING','WORKFLOW_BINDING','REPAIR_NOT_VERIFIED','UNRESOLVED_AWARD'].includes(error.code)){
      await deps.service.failJob(lease,deps.actor,error.code);return 'completed';
    }
    if(!lost){try{await deps.store.retryJob(lease.id,lease.leaseOwner,lease.leaseToken,now(),now()+Math.min(300_000,15_000*2**Math.min(lease.attempts,4)));}catch{/* The lease owner alone may retry; a successor can recover. */}}
    throw error;
  }finally{clearInterval(timer);}
}

export { scheduleCleanup } from './cleanup';
