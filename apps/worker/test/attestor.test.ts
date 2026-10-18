import {it,expect,vi} from 'vitest';
import {privateKeyToAccount} from 'viem/accounts';
import {encodeAbiParameters,keccak256,recoverTypedDataAddress,type AbiFunction} from 'viem';
import {hashCanonical,GENLAYER_CHAIN_ID} from '@faultline/protocol';
import {escrowAbi,escrowCreateArgs} from '@faultline/chain';
import {materialize} from '../src/attestor';
import {setup,WORKER} from '../../../packages/service/test/fixtures';
import schema from '../../../contracts/base/abi/authorization-schema.json';
const account=privateKeyToAccount(`0x${'1'.repeat(64)}`);
async function context(){
 const c=setup();await c.adjudicating();await c.job('adjudicate',{decision:await c.decision()});c.advance(86400_000);
 const w=(await c.store.getWorkflow(c.m.id))!,source=c.gateway.deployments.genlayer.address;
 const inputs=(escrowAbi.find(a=>a.type==='function'&&a.name==='createWorkflow') as AbiFunction).inputs;
 const termsHash=keccak256(encodeAbiParameters(inputs,escrowCreateArgs(c.m,source) as any));
 const escrow={workflowHash:w.record.hash,termsHash,genlayerChainId:GENLAYER_CHAIN_ID,genlayerContract:source,hardDeadline:c.now()/1000+100000,nextNonce:'2',state:3,caseId:w.record.caseId};
 const gateway={config:{genlayerAddress:source,escrowAddress:c.gateway.deployments.base.address,attestor:account.address.toLowerCase()},verifyDeployments:vi.fn(),readWorkflow:async()=>({workflowHash:w.record.hash,manifest:c.m}),readEscrow:async()=>escrow,base:{getBlock:async()=>({timestamp:BigInt(c.now()/1000)})},getReceipt:async(hash:string)=>{const r=structuredClone(c.gateway.receipts.get(hash)!);r.result={...r.result as object,cureDeadline:c.now()/1000-1};return r;}};
 const command={kind:'reserve' as const,actor:WORKER,workflow:w.record,payload:{},bindings:{workflowId:c.m.id,workflowHash:w.record.hash,caseId:w.record.caseId}};
 return {c,w,escrow,gateway,command};
}
it('signs only fixed terms and independently finalized resolved responsibility',async()=>{
 const {c,gateway,command}=await context();const result=await materialize(command,c.store,gateway as any,account) as any;
 expect(result.classes).toEqual([1,2]);expect(result.authorization.phase).toBe(2);
 const recovered=await recoverTypedDataAddress({domain:{name:'FaultlineBondEscrow',version:'1',chainId:84532,verifyingContract:gateway.config.escrowAddress as any},types:{ReservationAuthorization:schema.types.ReservationAuthorization},primaryType:'ReservationAuthorization',message:result.authorization,signature:result.signature});expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
});
it('refuses pending, altered terms and unresolved proofs before signing',async()=>{
 for(const mutation of ['pending','terms','unresolved','cure']){
  const {c,gateway,command,escrow}=await context();const original=gateway.getReceipt;
  if(mutation==='terms')escrow.termsHash=`0x${'0'.repeat(64)}`;
  else gateway.getReceipt=async hash=>{const r=await original(hash);if(mutation==='pending')r.finality='pending';if(mutation==='unresolved'){(r.result as any).decision.outcome='UNRESOLVED';(r.result as any).decision.remedyId=null;}if(mutation==='cure')(r.result as any).cureDeadline=c.now()/1000+1;return r;};
  const signer={...account,signTypedData:vi.fn()};await expect(materialize(command,c.store,gateway as any,signer)).rejects.toThrow();expect(signer.signTypedData).not.toHaveBeenCalled();
 }
});
it('requires a distinct finalized repair verdict before release',async()=>{
 const {c,gateway,command}=await context();const signer={...account,signTypedData:vi.fn()};
 await expect(materialize({...command,kind:'release'},c.store,gateway as any,signer)).rejects.toMatchObject({code:'PROOF_MISSING'});expect(signer.signTypedData).not.toHaveBeenCalled();
});
