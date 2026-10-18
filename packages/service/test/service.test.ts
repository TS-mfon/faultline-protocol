import { describe, expect, it } from 'vitest';
import { canonical, hashCanonical, hashText, type HandoffManifest, type RepairSubmission } from '@faultline/protocol';
import { FaultlineService, MemoryStore, type ChainGateway } from '../src';
import { setup, manifest, recoveryReady, A, B, R, WORKER, addr } from './fixtures';

describe('caller-controlled confirmation and durable state',()=>{
  it('keeps registration, acceptance and funding unconfirmed until successful finalized receipts',async()=>{
    const c=setup(), op=await c.service.createWorkflow(c.m,A,'replay');
    expect(op.status).toBe('awaiting_signature'); expect((await c.service.getWorkflow(c.m.id)).status).toBe('draft');
    const tx=await c.receipt(op,undefined,{finality:'pending'});
    expect((await c.service.confirmOperation(op.id,tx,A)).status).toBe('confirming');
    expect((await c.service.getWorkflow(c.m.id)).status).toBe('draft');
    c.gateway.receipts.get(tx)!.finality='finalized'; await c.service.confirmOperation(op.id,tx,A);
    await c.job('provision_escrow'); const accept=await c.service.prepareAcceptance(c.m.id,A);
    expect((await c.service.getWorkflow(c.m.id)).accepted).toEqual([]);
    await c.confirm(accept); const fund=await c.service.prepareFunding(c.m.id,A);
    expect((await c.service.getWorkflow(c.m.id)).bonded).toEqual({});
    await c.confirm(fund,{amount:'1000000'}); expect((await c.service.getWorkflow(c.m.id)).bonded[A]).toBe('1000000');
  });
  it('blocks live memory, mixed modes, and undeployed live gateways',async()=>{
    const c=setup(); expect(()=>new MemoryStore(undefined as never)).toThrow();
    await expect(c.service.createWorkflow(c.m,A)).rejects.toMatchObject({code:'GATEWAY_MODE'});
    const live={...c.gateway,mode:'live'} as unknown as ChainGateway;
    const service=new FaultlineService(c.store,live,c.options);
    await expect(service.createWorkflow(c.m,A)).rejects.toMatchObject({code:'MEMORY_LIVE_FORBIDDEN'});
    const durable=new Proxy(c.store,{get(target,p){return p==='durability'?'durable':Reflect.get(target,p);}});
    await expect(new FaultlineService(durable,live,c.options).createWorkflow(c.m,A)).rejects.toMatchObject({code:'LIVE_DEPLOYMENT_REQUIRED'});
  });
  it('rejects wrong callers, wrong mined senders, wrong target, altered calldata, and fabricated blocks',async()=>{
    const c=setup(),op=await c.service.createWorkflow(c.m,A,'replay'),tx=await c.receipt(op);
    await expect(c.service.confirmOperation(op.id,tx,B)).rejects.toMatchObject({code:'WRONG_SENDER'});
    for(const patch of [{from:B},{to:addr(90)},{chainId:1},{argsHash:hashText('wrong')},{blockNumber:'0'},{blockHash:`0x${'0'.repeat(64)}`},{workflowHash:hashText('wrong')},{deploymentHash:hashText('wrong')}]) {
      await c.receipt(op,undefined,patch); await expect(c.service.confirmOperation(op.id,tx,A)).rejects.toThrow();
      expect((await c.service.getWorkflow(c.m.id)).status).toBe('draft');
      expect((await c.service.getOperation(op.id)).status).toBe('awaiting_signature');
    }
    await c.receipt(op); await c.service.confirmOperation(op.id,tx,A);
    await expect(c.service.confirmOperation(op.id,hashText('second tx'),A)).rejects.toMatchObject({code:'TRANSACTION_CONFLICT'});
  });
  it('never converts a reverted or undetermined chain result into a contractual unresolved outcome',async()=>{
    for(const execution of ['reverted','undetermined'] as const) {
      const c=setup(),op=await c.service.createWorkflow(c.m,A,'replay');
      const result=await c.service.confirmOperation(op.id,await c.receipt(op,undefined,{execution}),A);
      expect(result.status).toBe('failed'); expect((await c.service.getWorkflow(c.m.id)).status).toBe('draft');
      expect(await c.store.claimJob('worker',c.now(),1000)).toBeNull();
    }
  });
  it('rejects a finalized deposit whose amount is wrong',async()=>{
    const c=setup(); await c.confirm(await c.service.createWorkflow(c.m,A,'replay')); await c.job('provision_escrow');
    await c.confirm(await c.service.prepareAcceptance(c.m.id,A)); const op=await c.service.prepareFunding(c.m.id,A);
    await expect(c.confirm(op,{amount:'1'})).rejects.toMatchObject({code:'FUNDING_AMOUNT'});
    expect((await c.service.getWorkflow(c.m.id)).bonded).toEqual({});
  });
  it('persists idempotency across service instances and parallel requests, rejects key reuse',async()=>{
    const c=setup(); const call=()=>c.service.withIdempotency('registration-1',()=>c.service.createWorkflow(c.m,A,'replay'));
    const ops=await Promise.all(Array.from({length:8},call)); expect(new Set(ops.map(o=>o.id)).size).toBe(1);
    const restarted=new FaultlineService(c.store,c.gateway,c.options);
    expect(await restarted.withIdempotency('registration-1',()=>restarted.createWorkflow(c.m,A,'replay'))).toEqual(ops[0]);
    await expect(restarted.withIdempotency('registration-1',()=>restarted.createWorkflow({...c.m,title:'Changed'},A,'replay'))).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect(await c.store.listOutbox()).toHaveLength(1); expect(await c.store.listOperations(c.m.id)).toHaveLength(1);
  });
  it('confirms once under a race and enqueues exactly one next job/event',async()=>{
    const c=setup(),op=await c.service.createWorkflow(c.m,A,'replay'),tx=await c.receipt(op);
    await Promise.all(Array.from({length:6},()=>c.service.confirmOperation(op.id,tx,A)));
    const jobs=await Promise.all(Array.from({length:4},(_,i)=>c.store.claimJob(`w${i}`,c.now(),1000)));
    expect(jobs.filter(Boolean)).toHaveLength(1); expect((await c.store.listOperations(c.m.id)).filter(o=>o.worker)).toHaveLength(1);
    expect((await c.store.listOutbox()).filter(e=>e.type==='operation.completed')).toHaveLength(1);
  });
  it('preserves immutable accepted terms and blocks late signatures at hard expiry',async()=>{
    const c=setup(),op=await c.service.createWorkflow(c.m,A,'replay');
    const read=await c.service.getWorkflow(c.m.id); read.manifest.title='mutated'; expect((await c.service.getWorkflow(c.m.id)).manifest.title).toBe(c.m.title);
    c.advance(604800000); await expect(c.confirm(op)).rejects.toMatchObject({code:'WORKFLOW_EXPIRED'});
    expect((await c.service.getWorkflow(c.m.id)).accepted).toEqual([]);
  });
});

describe('evidence journal, dependency acknowledgment and deadlines',()=>{
  it('requires exact latest predecessor acknowledgment before downstream production',async()=>{
    const c=setup(); await c.active();
    const handoff=(nodeId:string,producer:string,text:string,version=1,inputs:HandoffManifest['inputs']=[]):HandoffManifest=>({schemaVersion:1,id:hashText(`${nodeId}:${version}`),workflowId:c.m.id,nodeId,mandateVersion:1,artifactVersion:version,artifact:{hash:hashText(text),uri:'https://example.test/artifact',mediaType:'text/plain',size:Buffer.byteLength(text)},inputs,producer});
    const h=handoff('measure',A,'first'),next=handoff('report',B,'report',1,[{nodeId:'measure',handoffId:h.id,artifactHash:h.artifact.hash}]);
    await c.confirm(await c.service.publishHandoff(c.m.id,h,A));
    await expect(c.service.publishHandoff(c.m.id,next,B)).rejects.toMatchObject({code:'INPUT_NOT_ACKNOWLEDGED'});
    await c.confirm(await c.service.acknowledgeHandoff(c.m.id,h.id,B));
    await c.confirm(await c.service.publishHandoff(c.m.id,handoff('measure',A,'second',2),A));
    await expect(c.service.publishHandoff(c.m.id,next,B)).rejects.toMatchObject({code:'STALE_INPUT'});
  });
  it('matches GenLayer case digest and does not place synthetic journal entries in snapshots',async()=>{
    const c=setup(); await c.adjudicating(); const audit=await c.service.exportAudit(c.m.id);
    expect(audit.workflow.caseId).toBe(hashCanonical({workflowId:c.m.id,workflowHash:hashCanonical(c.m),report:{nodeId:'report',impact:'Published seconds as milliseconds',reporter:B}}));
    const s=audit.snapshots[0]!; expect(s.snapshot.evidence.map(e=>e.id)).toEqual(['source']);
    expect(Buffer.from((await c.store.getEvidence(s.hash))!).toString()).toBe(canonical(s.snapshot));
  });
  it('rejects duplicate pending/confirmed evidence and expired evidence',async()=>{
    const c=setup(); await c.evidenceOpen(); const text='another source',e={id:'new',text,hash:hashText(text),submittedBy:A};
    const op=await c.service.withIdempotency('new-source-1',()=>c.service.addEvidence(c.m.id,e,A));
    await expect(c.service.withIdempotency('new-source-2',()=>c.service.addEvidence(c.m.id,{...e,text:'changed',hash:hashText('changed')},A))).rejects.toMatchObject({code:'DUPLICATE_EVIDENCE'});
    await c.confirm(op); c.advance(86400000);
    await expect(c.service.addEvidence(c.m.id,{...e,id:'expired',hash:hashText('late'),text:'late'},A)).rejects.toMatchObject({code:'EVIDENCE_EXPIRED'});
  });
  it('revokes early-close votes when newly confirmed evidence arrives',async()=>{
    const c=setup(); await c.evidenceOpen(); await c.confirm(await c.service.closeEvidence(c.m.id,A));
    const text='new observation'; await c.confirm(await c.service.addEvidence(c.m.id,{id:'more',hash:hashText(text),text,submittedBy:B},B));
    await c.confirm(await c.service.closeEvidence(c.m.id,B));
    await expect(c.service.requestAdjudication(c.m.id,A)).rejects.toMatchObject({code:'EVIDENCE_OPEN'});
  });
  it('enforces the complete packet byte budget, counting manifest and UTF-8 bytes',async()=>{
    const c=setup(); await c.evidenceOpen(); const text='é'.repeat(26_000);
    await expect(c.service.addEvidence(c.m.id,{id:'huge',text,hash:hashText(text),submittedBy:A},A)).rejects.toMatchObject({code:'EVIDENCE_TOO_LARGE'});
    expect((await c.store.getWorkflow(c.m.id))!.evidence).toHaveLength(1);
  });
  it('keeps second evidence round separate and rejects a third round',async()=>{
    const c=setup(); await c.adjudicating(); await c.job('adjudicate',{decision:await c.decision('NEEDS_EVIDENCE')});
    expect((await c.service.getWorkflow(c.m.id)).evidenceRound).toBe(2);
    for(const a of [A,B]) await c.confirm(await c.service.closeEvidence(c.m.id,a));
    await c.service.requestAdjudication(c.m.id,B); const decision=await c.decision('NEEDS_EVIDENCE');
    await expect(c.job('adjudicate',{decision})).rejects.toMatchObject({code:'EVIDENCE_ROUND_LIMIT'});
    expect((await c.service.exportAudit(c.m.id)).snapshots).toHaveLength(2);
  });
  it('allows DECIDED to omit disconnected nodes but rejects omissions within the disputed path',async()=>{
    const m=manifest(); m.nodes.push({...m.nodes[0]!,id:'independent',dependencies:[]});
    const c=setup(m); await c.adjudicating(); const decision=await c.decision();
    const lease=await c.claim('adjudicate'),prepared=await c.service.prepareJob(lease,WORKER);
    const incomplete={...decision,findings:decision.findings.slice(1)};
    const hash=await c.receipt(prepared.operation,{decision:incomplete});
    await expect(c.service.confirmJob(lease,hash,WORKER)).rejects.toMatchObject({code:'DECISION_INCOMPLETE'});
    await c.receipt(prepared.operation,{decision}); await c.service.confirmJob(lease,hash,WORKER);
    expect((await c.service.getWorkflow(m.id)).status).toBe('decided');
  });
});

describe('separate repair finality and immutable worker intents',()=>{
  it('requires cure, reservation, a bound repair verdict and a separate release receipt',async()=>{
    const c=setup(); await c.adjudicating(); await c.job('adjudicate',{decision:await c.decision()});
    expect(await c.store.claimJob('early',c.now(),1000)).toBeNull();
    c.advance(86400000); await c.job('reserve');
    const w=await c.service.getWorkflow(c.m.id), text='correct output';
    const submission:RepairSubmission={schemaVersion:1,workflowId:c.m.id,caseId:w.caseId!,remedyId:'correct',recipient:R,artifacts:[{hash:hashText(text),uri:'https://example.test/fixed',mediaType:'text/plain',size:Buffer.byteLength(text)}],evidence:[{id:'fixed',text,hash:hashText(text),submittedBy:R}],previousHashes:[w.hash]};
    const op=await c.service.submitRepair(c.m.id,submission,R); expect((await c.service.getWorkflow(c.m.id)).status).toBe('repairing');
    await c.confirm(op); expect((await c.service.getWorkflow(c.m.id)).status).toBe('verifying_repair');
    const lease=await c.claim('verify_repair'),prepared=await c.service.prepareJob(lease,WORKER);
    const verdict={schemaVersion:1,workflowId:c.m.id,caseId:w.caseId!,decisionId:hashCanonical(w.decision),repairHash:hashCanonical(submission),remedyId:'correct',accepted:true,checks:[{nodeId:'measure',satisfied:true},{nodeId:'report',satisfied:true}],evidenceRefs:['fixed'],rationale:'Fixture repair verification'};
    const hash=await c.receipt(prepared.operation,{repairAccepted:true});
    await expect(c.service.confirmJob(lease,hash,WORKER)).rejects.toMatchObject({code:'REPAIR_JUDGMENT_BINDING'});
    await c.receipt(prepared.operation,{repairAccepted:true,repairVerdict:verdict,repairVerdictId:hashCanonical(verdict)});
    await c.service.confirmJob(lease,hash,WORKER); expect((await c.service.getWorkflow(c.m.id)).status).toBe('verifying_repair');
    const released={state:5,remedyId:hashText('correct'),reservationDecisionId:hashCanonical(w.decision),reservationSnapshotHash:w.decision!.snapshotHash,repairDecisionId:hashCanonical(verdict),repairHash:hashCanonical(submission)};
    const releaseLease=await c.claim('release'),release=await c.service.prepareJob(releaseLease,WORKER);
    await expect(c.service.confirmJob(releaseLease,await c.receipt(release.operation),WORKER)).rejects.toMatchObject({code:'RELEASE_NOT_CONFIRMED'});
    await c.service.confirmJob(releaseLease,await c.receipt(release.operation,released),WORKER);
    expect((await c.service.getWorkflow(c.m.id)).status).toBe('verifying_repair');
    const payoutLease=await c.claim('payout'),payout=await c.service.prepareJob(payoutLease,WORKER);
    const payment={...released,beneficiary:R,withdrawnAmount:c.m.repairs[0].price,usdcTransferVerified:true};
    for(const patch of [{usdcTransferVerified:undefined},{usdcTransferVerified:false},{beneficiary:A},{withdrawnAmount:'1'},{state:6},{repairDecisionId:hashText('wrong repair')}]){
      await expect(c.service.confirmJob(payoutLease,await c.receipt(payout.operation,{...payment,...patch}),WORKER)).rejects.toThrow();
      expect((await c.service.getWorkflow(c.m.id)).status).toBe('verifying_repair');
    }
    const payoutHash=await c.receipt(payout.operation,payment,{finality:'pending'});
    expect((await c.service.confirmJob(payoutLease,payoutHash,WORKER)).status).toBe('confirming');
    expect((await c.service.getWorkflow(c.m.id)).status).toBe('verifying_repair');
    await c.receipt(payout.operation,payment);await c.service.confirmJob(payoutLease,payoutHash,WORKER);
    expect((await c.service.getWorkflow(c.m.id)).status).toBe('completed');
    expect((await c.service.exportAudit(c.m.id)).mode).toBe('replay');
  });
  it('recovers a failed payout through a separately verified cleanup withdrawal',async()=>{
    const {c,released}=await recoveryReady();await c.job('release',released);
    const lease=await c.claim('payout');await c.service.prepareJob(lease,WORKER);
    await c.service.failJob(lease,WORKER,'TRANSACTION_REVERTED');
    await c.service.queueCleanup(c.m.id,'withdraw',WORKER,R);
    await c.job('withdraw',{...released,beneficiary:R,withdrawnAmount:c.m.repairs[0].price,usdcTransferVerified:true});
    expect((await c.service.getWorkflow(c.m.id)).status).toBe('completed');
    expect((await c.store.listOperations(c.m.id)).find(o=>o.kind==='payout')!.operation.status).toBe('failed');
  });
  it('preserves a completed recovery when queued expiry confirms after payout',async()=>{
    const {c,released}=await recoveryReady();await c.job('release',released);
    c.advance(604800000);
    // Cleanup observed the unpaid workflow, then payout finalized before expiry.
    await c.service.queueCleanup(c.m.id,'expire',WORKER);
    await c.job('payout',{...released,beneficiary:R,withdrawnAmount:c.m.repairs[0].price,usdcTransferVerified:true});
    expect((await c.service.getWorkflow(c.m.id)).status).toBe('completed');
    await c.job('expire',{status:'completed'});
    expect((await c.service.getWorkflow(c.m.id)).status).toBe('completed');
  });
  it('persists materialized intent once and fences reclaimed workers',async()=>{
    const c=setup(); await c.confirm(await c.service.createWorkflow(c.m,A,'replay'));
    const lease=await c.claim('provision_escrow'),payload={authorization:{nonce:'1'},signature:'fixture'};
    const prepared=await c.service.prepareJob(lease,WORKER,payload);
    await expect(c.service.prepareJob(lease,WORKER,{authorization:{nonce:'2'}})).rejects.toMatchObject({code:'INTENT_IMMUTABLE'});
    const hash=await c.receipt(prepared.operation); await c.service.recordJobSubmission(lease,hash,WORKER);
    c.advance(60000); const reclaimed=await c.claim('provision_escrow');
    await expect(c.service.confirmJob(lease,hash,WORKER)).rejects.toMatchObject({code:'LEASE_LOST'});
    expect((await c.service.prepareJob(reclaimed,WORKER)).operation.txHash).toBe(hash);
    await c.service.confirmJob(reclaimed,hash,WORKER); expect((await c.service.getOperation(prepared.operation.id)).status).toBe('completed');
  });
});

describe('worker authorization privacy',()=>{
 it('withholds a pending worker intent from public reads and audit exports',async()=>{
  const c=setup();await c.confirm(await c.service.createWorkflow(c.m,A,'replay'));
  const lease=await c.claim('provision_escrow');const prepared=await c.service.prepareJob(lease,WORKER);
  expect(prepared.operation.intent).toBeDefined();expect((await c.service.getOperation(prepared.operation.id)).intent).toBeUndefined();
  expect((await c.service.exportAudit(c.m.id)).operations.find(o=>o.id===prepared.operation.id)!.intent).toBeUndefined();
  const hash=await c.receipt(prepared.operation);await c.service.recordJobSubmission(lease,hash,WORKER);await c.service.confirmJob(lease,hash,WORKER);
  const submitted=(await c.store.listOutbox()).find(e=>e.type==='operation.submitted'&&e.operationId===prepared.operation.id)!;
  expect((submitted.payload as any).operation.intent).toBeUndefined();
  expect((await c.service.getOperation(prepared.operation.id)).intent).toBeDefined();
 });
 it('redacts prepared worker intents on idempotent request retries',async()=>{
  const c=setup();const adjudication=await c.adjudicating();const lease=await c.claim('adjudicate');
  await c.service.prepareJob(lease,WORKER);
  const retried=await c.service.requestAdjudication(c.m.id,A);
  expect(retried.id).toBe(adjudication.id);expect(retried.intent).toBeUndefined();
 });
 it('keeps terminal workflows eligible for fixed-beneficiary refunds without redirecting funds',async()=>{
  const c=setup();await c.active();
  const original=(await c.store.getWorkflow(c.m.id))!;const changed=structuredClone(original);changed.record.status='unresolved';changed.record.revision++;
  await c.store.commit({workflow:{expectedRevision:original.record.revision,value:changed}});
  await expect(c.service.queueCleanup(c.m.id,'withdraw',WORKER,addr(90))).rejects.toMatchObject({code:'FORBIDDEN'});
  const op=await c.service.queueCleanup(c.m.id,'refund_escrow',WORKER);expect(op.status).toBe('queued');
  expect((await c.service.queueCleanup(c.m.id,'refund_escrow',WORKER)).id).toBe(op.id);
  await c.job('refund_escrow',{state:6});expect((await c.service.getWorkflow(c.m.id)).status).toBe('unresolved');
  await c.service.queueCleanup(c.m.id,'withdraw',WORKER,A);
  const lease=await c.claim('withdraw'),prepared=await c.service.prepareJob(lease,WORKER);
  const payment={state:6,beneficiary:A,withdrawnAmount:c.m.bonds[A]};
  await expect(c.service.confirmJob(lease,await c.receipt(prepared.operation,payment),WORKER)).rejects.toMatchObject({code:'WITHDRAWAL_MISSING'});
  await c.service.confirmJob(lease,await c.receipt(prepared.operation,{...payment,usdcTransferVerified:true}),WORKER);
  expect((await c.service.getWorkflow(c.m.id)).status).toBe('unresolved');
 });
});
