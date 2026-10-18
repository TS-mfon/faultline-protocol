import {it,expect,vi} from 'vitest';
import {domains,replay,makeManifest,scenarios} from '../src/scenarios';
import {executeTask} from '../src/tasks';
import {runTick,initialState} from '../src/live';
import {verifyAudit} from '../src/verify';
import {hashCanonical,hashText} from '@faultline/protocol';
import {recoveryReady,R,WORKER} from '../../packages/service/test/fixtures';
for(const domain of domains)it(`${domain} uses three accountable agents, immutable complete evidence and bounded 9/3/0 repair`,()=>{
 const r=replay(domain);expect(r.manifest.nodes).toHaveLength(3);expect(r.manifest.repairCap).toBe('12000000');expect(Object.values(r.manifest.bonds)).toEqual(['12000000','12000000','12000000']);
 expect(r.allocation.map(a=>a.amount)).toEqual(['9000000','3000000','0']);expect(r.decision.snapshotHash).toBe(hashCanonical(r.snapshot));
 for(const h of r.snapshot.handoffs)expect(r.snapshot.evidence.some(e=>e.hash===h.artifact.hash&&hashText(e.text)===e.hash)).toBe(true);
 expect(r.receipts).toEqual([]);expect(r.transferredUsdc).toBe('0');expect(r.mode).toBe('replay');
 expect(JSON.stringify(r.snapshot)).not.toContain('faultPrompt');
});
it('labels deterministic work and computes repairs without deciding responsibility',()=>{
 const repaired=domains.map(domain=>executeTask({domain,task:'repair',source:scenarios[domain].source}));
 expect(JSON.parse(repaired[0].text).mean_ms).toBe(200);expect(JSON.parse(repaired[1].text).improvement_pp).toBe(10);expect(JSON.parse(repaired[2].text)).toMatchObject({landed_cost_usd:580,within_budget:false});
 for(const output of repaired){expect(output.mode).toBe('deterministic-task');expect(output.outputHash).toBe(hashText(output.text));expect(output.text).not.toMatch(/planted|fault injection|primary responsibility|contributory responsibility/);}
 for(const scenario of Object.values(scenarios))expect(scenario.source).not.toMatch(/required_mean|absolute_improvement|expected|faultPrompt|required_landed/);
});
it('a pending registration never advances into agent work or deposits',async()=>{
 const r=replay('software'),state=initialState('software',{creator:r.manifest.creator,agents:r.manifest.nodes.map(n=>n.agent) as any,repairer:r.manifest.repairs[0].recipient},'live-test');
 const op={id:hashText('operation'),kind:'register',status:'awaiting_signature',intent:{chain:'genlayer',chainId:4221,to:r.manifest.creator,functionName:'register_workflow',args:[]}};
 const c={putArtifact:vi.fn(async()=>({hash:hashText(scenarios.software.source)})),createWorkflow:vi.fn(async()=>op),getOperation:vi.fn(async()=>op)},save=vi.fn(),task=vi.fn(),sign=vi.fn(async()=>null);
 const deps={state,save,client:async()=>c as any,task,sign,fundApproval:vi.fn(),evidenceOrigin:'https://faultline.test/api/v1/evidence',verifyAudit:vi.fn()};
 expect(await runTick(deps)).toMatchObject({stage:'register-finality',complete:false});expect(state.operations.register.id).toBe(op.id);
 await runTick(deps);expect(c.createWorkflow).toHaveBeenCalledTimes(1);expect(task).not.toHaveBeenCalled();expect(deps.fundApproval).not.toHaveBeenCalled();
});
it('live verification fails on replay or missing payment rather than accepting a success flag',async()=>{
 await expect(verifyAudit(replay('software'),{} as any)).rejects.toThrow();
 const r=replay('software');await expect(verifyAudit({mode:'live',workflow:{mode:'live',manifest:r.manifest,hash:hashCanonical(r.manifest),status:'completed'},operations:[]},{} as any)).rejects.toThrow('Missing adjudicate');
});

// Explicitly mocked chain responses exercise the verifier. These are never live artifacts.
async function auditFixture(cleanup=false) {
 const {c,released}=await recoveryReady();await c.job('release',released);
 const payment={...released,beneficiary:R,withdrawnAmount:c.m.repairs[0].price,usdcTransferVerified:true};
 if(cleanup){
  const lease=await c.claim('payout');await c.service.prepareJob(lease,WORKER);await c.service.failJob(lease,WORKER,'TRANSACTION_REVERTED');
  await c.service.queueCleanup(c.m.id,'withdraw',WORKER,R);await c.job('withdraw',payment);
 }else await c.job('payout',payment);
 const audit=await c.service.exportAudit(c.m.id);
 for(const receipt of c.gateway.receipts.values()){
  receipt.caseId=audit.workflow.caseId;
  if(receipt.functionName==='adjudicate')receipt.decisionHash=hashCanonical((receipt.result as any).decision);
  if(receipt.functionName==='reserveAward')receipt.result={...released,state:4};
 }
 const input={...audit,mode:'live',workflow:{...audit.workflow,mode:'live'}};
 const gateway={getReceipt:(hash:string)=>c.gateway.getReceipt(hash)};
 return {c,input,gateway};
}

it('independently verifies the fixed beneficiary and every distinct phase, including cleanup payouts',async()=>{
 for(const cleanup of [false,true]){
  const {input,gateway}=await auditFixture(cleanup);
  const verified=await verifyAudit(input,gateway as any);
  expect(verified.recipient).toBe(R);expect(verified.withdrawnAmount).toBe('750000');expect(verified.receipts).toHaveLength(5);
 }
});

it('rejects altered phases, finality, evidence, repair verdicts and token-transfer claims',async()=>{
 for(const fault of ['phase','pending','snapshot','verdict','transfer','refunded']){
  const {c,input,gateway}=await auditFixture();
  if(fault==='phase')input.operations.find(o=>o.kind==='reserve')!.intent!.functionName='withdrawFor';
  if(fault==='snapshot')input.snapshots[0].snapshot.evidence[0].text='Changed committed evidence';
  const paymentOp=input.operations.find(o=>o.kind==='payout')!,payment=c.gateway.receipts.get(paymentOp.txHash!)!;
  if(fault==='pending')payment.finality='pending';
  if(fault==='transfer')(payment.result as any).usdcTransferVerified=false;
  if(fault==='refunded')(payment.result as any).state=6;
  if(fault==='verdict'){
   const op=input.operations.find(o=>o.kind==='verify_repair')!;
   (c.gateway.receipts.get(op.txHash!)!.result as any).repairVerdict.decisionId=hashText('different decision');
  }
  await expect(verifyAudit(input,gateway as any)).rejects.toThrow();
 }
});
