import {hashCanonical,hashText,allocateRepair,validateWorkflow,validateDecision} from '@faultline/protocol';
import type {LiveChainGateway} from '@faultline/chain';
import type {Operation} from '@faultline/protocol';
/** Re-read receipts. Local booleans, audit status and elapsed time are never payment proof. */
export async function verifyAudit(audit:any,gateway:LiveChainGateway){
 if(audit?.mode!=='live'||audit?.workflow?.mode!=='live'||audit.workflow.status!=='completed')throw new Error('Only a completed live workflow can be verified');
 const m=validateWorkflow(audit.workflow.manifest);if(hashCanonical(m)!==audit.workflow.hash)throw new Error('Manifest hash mismatch');
 const remedy=m.repairs.find(r=>r.id===audit.workflow.decision?.remedyId);
 const receipts=[];
 const phases=[['adjudicate','genlayer','adjudicate'],['reserve','base','reserveAward'],['verify_repair','genlayer','verify_repair'],['release','base','releaseRepair'],['payout','base','withdrawFor']] as const;
 for(const [kind,chain,method] of phases){
  const op=(audit.operations as Operation[]).filter(o=>o.status==='completed'&&(kind==='payout'?(o.kind==='payout'||(o.kind==='withdraw'&&(o.result as any)?.beneficiary===remedy?.recipient)):o.kind===kind)).at(-1);
  if(!op?.txHash||!op.intent)throw new Error(`Missing ${kind} transaction`);
  const observedSelfWithdrawal=kind==='payout'&&op.kind==='withdraw'&&op.intent.functionName==='withdraw';
  if(op.intent.chain!==chain||(!observedSelfWithdrawal&&op.intent.functionName!==method))throw new Error(`${kind} references the wrong transaction phase`);
  const receipt=await gateway.getReceipt(op.txHash,op.intent);
  if(!receipt||receipt.execution!=='success'||receipt.finality!=='finalized'||receipt.transactionHash!==op.txHash||receipt.chain!==chain||receipt.functionName!==op.intent.functionName||receipt.argsHash!==hashCanonical(op.intent.args)||receipt.workflowHash!==audit.workflow.hash||receipt.workflowId!==m.id||(observedSelfWithdrawal&&(receipt.from!==remedy?.recipient||hashCanonical(op.intent.args)!==hashCanonical([m.id]))))throw new Error(`${kind} lacks independent finalized execution proof`);
  receipts.push(receipt);
 }
 const [judgment,reservation,repair,release,payment]=receipts;
 if(new Set(receipts.map(r=>r.transactionHash)).size!==phases.length)throw new Error('Settlement phases require distinct transactions');
 const snapshot=audit.snapshots?.find((s:any)=>s.hash===audit.workflow.decision?.snapshotHash)?.snapshot;
 if(!snapshot||hashCanonical(snapshot)!==audit.workflow.decision.snapshotHash)throw new Error('Frozen judgment evidence is missing or changed');
 const decision=validateDecision(m,snapshot,audit.workflow.decision),decisionId=hashCanonical(decision);
 if(hashCanonical((judgment.result as any).decision)!==decisionId||judgment.decisionHash!==decisionId||judgment.snapshotHash!==decision.snapshotHash||receipts.some(r=>r.caseId!==decision.caseId))throw new Error('Audit decision differs from chain');
 const repairView=repair.result as any,verdict=repairView?.repairVerdict,repairHash=hashCanonical(audit.repair);
 if(!verdict||repairView.repairAccepted!==true||verdict.accepted!==true||repairView.repairVerdictId!==hashCanonical(verdict)||verdict.workflowId!==m.id||verdict.caseId!==decision.caseId||verdict.decisionId!==decisionId||verdict.remedyId!==decision.remedyId||verdict.repairHash!==repairHash||repair.repairHash!==repairHash)throw new Error('Missing separate bound accepted repair');
 const paid=payment.result as any;
 if(!remedy||paid.beneficiary!==remedy.recipient||BigInt(paid.withdrawnAmount??'0')<BigInt(remedy.price)||paid.usdcTransferVerified!==true)throw new Error('Missing actual fixed-beneficiary USDC transfer');
 if((reservation.result as any)?.remedyId!==hashText(remedy.id)||reservation.decisionHash!==decisionId||reservation.snapshotHash!==decision.snapshotHash||release.decisionHash!==repairView.repairVerdictId||release.snapshotHash!==repairHash)throw new Error('Settlement does not bind the consensus verdicts');
 for(const view of [release.result,payment.result] as any[]){
  if(Number(view?.state)!==5||view.remedyId!==hashText(remedy.id)||view.repairDecisionId!==repairView.repairVerdictId||view.repairHash!==repairHash||view.reservationDecisionId!==decisionId||view.reservationSnapshotHash!==decision.snapshotHash)throw new Error('Payment does not come from the released repair award');
 }
 return {workflowId:m.id,allocation:allocateRepair(m,decision),repairPrice:remedy.price,withdrawnAmount:paid.withdrawnAmount,recipient:paid.beneficiary,receipts,verifiedAt:new Date().toISOString()};
}
