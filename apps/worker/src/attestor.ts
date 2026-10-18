import { BASE_CHAIN_ID, GENLAYER_CHAIN_ID, USDC_ADDRESS, CLASS_CODES, hashCanonical, hashText, participants, validateDecision, ProtocolError } from '@faultline/protocol';
import { escrowAbi, escrowCreateArgs, type LiveChainGateway } from '@faultline/chain';
import type { GatewayCommand, GatewayReceipt, Store } from '@faultline/service';
import { encodeAbiParameters, keccak256, type Account, type AbiFunction } from 'viem';
import schema from '../../../contracts/base/abi/authorization-schema.json';
const ZERO=`0x${'0'.repeat(64)}`;
export async function confirmed(store:Store,gateway:LiveChainGateway,id:string,kind:string):Promise<GatewayReceipt>{
  const current=await store.getWorkflow(id);
  const ops=(await store.listOperations(id)).filter(o=>o.kind===kind&&o.operation.status==='completed'&&(kind!=='adjudicate'||o.bindings.snapshotHash===current?.currentSnapshotHash));
  const op=ops[0]; if(!op?.operation.intent || !op.operation.txHash)throw new ProtocolError('PROOF_MISSING',`No completed ${kind} transaction`);
  const r=await gateway.getReceipt(op.operation.txHash,op.operation.intent);
  if(!r||r.execution!=='success'||r.finality!=='finalized'||r.workflowId!==id||r.workflowHash!==op.bindings.workflowHash||r.from!==op.actor||r.argsHash!==hashCanonical(op.operation.intent.args)||Object.entries(op.bindings).some(([key,value])=>r[key as keyof GatewayReceipt]!==value))throw new ProtocolError('NOT_FINALIZED','Independent receipt recheck failed');
  return r;
}
/** Explicit single-attestor bridge. No model-generated payout amounts or beneficiaries are signed. */
export async function materialize(command:GatewayCommand,store:Store,gateway:LiveChainGateway,account:Account):Promise<unknown>{
  const {kind,workflow}=command,id=workflow.manifest.id,m=workflow.manifest;
  if(!['activate_escrow','activate','reserve','release','open_case_escrow','provision_escrow'].includes(kind))return command.payload;
  await gateway.verifyDeployments();
  const chain=await gateway.readWorkflow(id);
  if(chain.workflowHash!==workflow.hash||hashCanonical(chain.manifest)!==workflow.hash)throw new ProtocolError('WORKFLOW_BINDING','GenLayer commitment differs from the accepted manifest');
  if(kind==='provision_escrow'){await confirmed(store,gateway,id,'register');return command.payload;}
  if(kind==='open_case_escrow'){const report=await confirmed(store,gateway,id,'report');if(report.caseId!==command.bindings.caseId)throw new ProtocolError('CASE_BINDING','Case differs from GenLayer');return {caseId:report.caseId};}
  const escrow=await gateway.readEscrow(id);
  const create=escrowAbi.find(x=>x.type==='function'&&x.name==='createWorkflow') as AbiFunction;
  const termsHash=keccak256(encodeAbiParameters(create.inputs,escrowCreateArgs(m,gateway.config.genlayerAddress) as any));
  if(escrow.workflowHash!==workflow.hash||escrow.termsHash!==termsHash||String(escrow.genlayerChainId)!==String(GENLAYER_CHAIN_ID)||escrow.genlayerContract.toLowerCase()!==gateway.config.genlayerAddress)throw new ProtocolError('TERMS_BINDING','Escrow terms or source chain differ from accepted commitments');
  if(kind==='activate'){
    const proof=await confirmed(store,gateway,id,'activate_escrow');const e=proof.result as any;
    return {fundingReceipt:{schemaVersion:1,workflowId:id,workflowHash:workflow.hash,baseChainId:BASE_CHAIN_ID,escrowAddress:gateway.config.escrowAddress,tokenAddress:USDC_ADDRESS.toLowerCase(),genlayerChainId:GENLAYER_CHAIN_ID,genlayerContract:gateway.config.genlayerAddress,bonds:m.bonds,lockedAt:Number(e.hardDeadline)-604800,expiresAt:Number(e.hardDeadline),txHash:proof.transactionHash,blockHash:proof.blockHash,finalized:true,success:true}};
  }
  const block=await gateway.base.getBlock({blockTag:'latest'});const now=Number(block.timestamp), expiry=Math.min(now+900,Number(escrow.hardDeadline),kind==='release'?Number(escrow.repairDeadline):Infinity);
  if(expiry<=now)throw new ProtocolError('WORKFLOW_EXPIRED','No attestation is valid after escrow maturity');
  let primaryType:'ActivationAuthorization'|'ReservationAuthorization'|'ReleaseAuthorization';let fields:Record<string,unknown>, classes:number[]|undefined;
  const common={workflowId:id,workflowHash:workflow.hash,termsHash,genlayerChainId:String(GENLAYER_CHAIN_ID),genlayerContract:gateway.config.genlayerAddress,nonce:String(escrow.nextNonce),expiry:String(expiry)};
  if(kind==='activate_escrow'){
    if(Number(escrow.state)!==1||Number(escrow.fundedCount)!==participants(m).length||participants(m).some(a=>!chain.accepted.includes(a)))throw new ProtocolError('NOT_FUNDED','All commitments and bonds are required');
    const ops=await store.listOperations(id);const proofs:GatewayReceipt[]=[];
    for(const actor of participants(m)) for(const action of ['accept','fund']) {
      const op=ops.find(o=>o.kind===action&&o.actor===actor&&o.operation.status==='completed');
      if(!op?.operation.txHash||!op.operation.intent)throw new ProtocolError('PROOF_MISSING','An acceptance or bond receipt is missing');
      const r=await gateway.getReceipt(op.operation.txHash,op.operation.intent);
      if(!r||r.execution!=='success'||r.finality!=='finalized'||r.from!==actor||r.workflowHash!==workflow.hash||(action==='fund'&&(r.result as any)?.amount!==m.bonds[actor]))throw new ProtocolError('NOT_FUNDED','Receipt does not prove the exact accepted bond');proofs.push(r);
    }
    primaryType='ActivationAuthorization';const snapshotHash=hashCanonical(proofs);
    fields={...common,phase:1,caseId:ZERO,snapshotHash,decisionId:hashCanonical({kind:'activation',workflowId:id,snapshotHash})};
  }else if(kind==='reserve'){
    const proof=await confirmed(store,gateway,id,'adjudicate'), stored=await store.getWorkflow(id),view=proof.result as any;
    const snapshot=stored?.snapshots.find(s=>s.hash===proof.snapshotHash)?.snapshot;
    if(!snapshot)throw new ProtocolError('PROOF_MISSING','Frozen adjudication snapshot is absent');
    const decision=validateDecision(m,snapshot,view.decision);
    if(decision.outcome!=='DECIDED'||!decision.remedyId||decision.findings.some(f=>f.class==='unresolved'))throw new ProtocolError('UNRESOLVED_AWARD','Unresolved responsibility cannot reserve money');
    if(now<Number(view.cureDeadline)||Number(escrow.state)!==3||escrow.caseId!==decision.caseId)throw new ProtocolError('CURE_OPEN','The case and cure period must be complete');
    classes=m.nodes.map(n=>{const f=decision.findings.find(f=>f.nodeId===n.id);return f?CLASS_CODES[f.class]:0;});
    primaryType='ReservationAuthorization';fields={...common,phase:2,caseId:decision.caseId,snapshotHash:proof.snapshotHash,decisionId:hashCanonical(decision),remedyId:hashText(decision.remedyId),classesHash:keccak256(encodeAbiParameters([{type:'uint8[]'}],[classes]))};
  }else{
    const proof=await confirmed(store,gateway,id,'verify_repair'),reservation=await confirmed(store,gateway,id,'reserve'),view=proof.result as any;
    const verdict=view.repairVerdict;
    if(view.repairAccepted!==true||!verdict||verdict.accepted!==true||hashCanonical(verdict)!==view.repairVerdictId||verdict.repairHash!==view.repairHash||verdict.workflowId!==id||verdict.caseId!==escrow.caseId||Number(escrow.state)!==4||reservation.decisionHash!==escrow.reservationDecisionId||reservation.snapshotHash!==escrow.reservationSnapshotHash)throw new ProtocolError('REPAIR_NOT_VERIFIED','Separate finalized repair judgment must match the reserved recovery');
    primaryType='ReleaseAuthorization';fields={...common,phase:3,caseId:escrow.caseId,snapshotHash:view.repairHash,decisionId:view.repairVerdictId,repairHash:view.repairHash,remedyId:escrow.remedyId,reservationDecisionId:escrow.reservationDecisionId,reservationSnapshotHash:escrow.reservationSnapshotHash};
  }
  if(!account.signTypedData||account.address.toLowerCase()!==gateway.config.attestor)throw new ProtocolError('WRONG_ATTESTOR','Signer is not the configured attestor');
  const signature=await account.signTypedData({domain:{name:'FaultlineBondEscrow',version:'1',chainId:BASE_CHAIN_ID,verifyingContract:gateway.config.escrowAddress},types:{[primaryType]:schema.types[primaryType]},primaryType,message:fields} as any);
  return {authorization:fields,signature,...(classes?{classes}:{})};
}
