import { participants } from '@faultline/protocol';
import { escrowAbi, type LiveChainGateway } from '@faultline/chain';
import type { FaultlineService, Store } from '@faultline/service';
/** Chain timestamps decide maturity. Cleanup remains available for terminal app cases. */
export async function scheduleCleanup(store:Store,service:FaultlineService,gateway:LiveChainGateway,actor:string) {
  const block=await gateway.base.getBlock({blockTag:'finalized'}),now=Number(block.timestamp);
  let queued=0;
  for(const {record:r,escrowReady,receipts=[]} of await store.listWorkflows()){
    if(r.mode!=='live'||!escrowReady)continue;
    const e=await gateway.readEscrow(r.manifest.id,block.number),state=Number(e.state);
    if(state>0&&state<5&&(now>=Number(e.hardDeadline)||(state===4&&now>=Number(e.repairDeadline)))){
      await service.queueCleanup(r.manifest.id,'refund_escrow',actor);queued++;
    }
    if(state===5||state===6){
      const pendingBeneficiaries=new Set((await store.listOperations(r.manifest.id))
        .filter(o=>o.kind==='payout'&&!['completed','failed'].includes(o.operation.status))
        .map(o=>(o.payload as {beneficiary:string}).beneficiary));
      for(const beneficiary of new Set([...participants(r.manifest),...r.manifest.repairs.map(x=>x.recipient)])){
        const account=await gateway.base.readContract({address:gateway.config.escrowAddress,abi:escrowAbi,functionName:'getAccount',args:[r.manifest.id,beneficiary],blockNumber:block.number}) as bigint[];
        if(account[4]>0n){
          // A dedicated payout operation owns the repairer's available credit until it is confirmed.
          if(!pendingBeneficiaries.has(beneficiary)){await service.queueCleanup(r.manifest.id,'withdraw',actor,beneficiary);queued++;}
        }else if(!receipts.some(receipt=>['withdraw','withdrawFor'].includes(receipt.functionName)&&(receipt.result as any)?.beneficiary===beneficiary)){
          const anchors=receipts.filter(receipt=>receipt.chain==='base'&&(state===6||receipt.functionName==='releaseRepair'));
          const eligible=account[1]>0n||(state===5&&r.manifest.repairs.some(repair=>repair.id===r.decision?.remedyId&&repair.recipient===beneficiary));
          if(eligible&&anchors.length){
            const start=anchors.reduce((min,receipt)=>BigInt(receipt.blockNumber)<min?BigInt(receipt.blockNumber):min,block.number);
            const hash=await gateway.findWithdrawal(r.manifest.id as `0x${string}`,beneficiary as `0x${string}`,start,block.number);
            if(hash)await service.reconcileWithdrawal(r.manifest.id,hash,beneficiary,actor);
          }
        }
      }
    }
    if(now>=Date.parse(r.expiresAt)/1000&&!['completed','unresolved','recovery_failed','expired','draft'].includes(r.status))await service.queueCleanup(r.manifest.id,'expire',actor);
  }
  return queued;
}
