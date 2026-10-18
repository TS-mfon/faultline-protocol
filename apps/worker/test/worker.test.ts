import {it,expect,vi} from 'vitest';
import {hashCanonical,hashText,ProtocolError,type TransactionIntent} from '@faultline/protocol';
import {keccak256} from 'viem';
import {journalOnce,type SignedRecord,type SigningJournal} from '../src/signer';
import {runOne} from '../src';
import {setup,A,WORKER} from '../../../packages/service/test/fixtures';
it('persists signed bytes before retry and rejects replacement intent after a crash',async()=>{
 const records=new Map<string,SignedRecord>();
 const journal:SigningJournal={get:async id=>records.get(id)??null,latest:async()=>null,latestNonce:async()=>-1,insert:async r=>{records.set(r._id,r);return r;},setLogicalHash:async()=>{}};
 const intent:TransactionIntent={chain:'base',chainId:84532,to:A,functionName:'withdrawFor',args:[hashText('workflow'),A],value:'0'};
 const sign=vi.fn(async()=>({_id:'id',intentHash:hashCanonical(intent),chainId:84532,from:A,nonce:1,raw:'0x1234' as const,evmHash:keccak256('0x1234')}));
 const first=await journalOnce(journal,'id',intent,sign);expect(await journalOnce(journal,'id',intent,sign)).toEqual(first);expect(sign).toHaveBeenCalledTimes(1);
 await expect(journalOnce(journal,'id',{...intent,args:[]},sign)).rejects.toMatchObject({code:'INTENT_IMMUTABLE'});
});
it('resumes a prepared submission without rematerializing or signing again',async()=>{
 const c=setup();await c.confirm(await c.service.createWorkflow(c.m,A,'replay'));
 const lease=await c.claim('provision_escrow'),{operation}=await c.service.prepareJob(lease,WORKER);const hash=await c.receipt(operation);
 await c.service.recordJobSubmission(lease,hash,WORKER);await c.store.retryJob(lease.id,lease.leaseOwner,lease.leaseToken,c.now(),c.now());
 const materialize=vi.fn(),submit=vi.fn();
 expect(await runOne({service:c.service,store:c.store,actor:WORKER,owner:'restarted',materialize,submit,now:c.now})).toBe('completed');
 expect(submit).not.toHaveBeenCalled();expect(materialize).not.toHaveBeenCalled();
});
it('durably fails reverted immutable operations without retrying signatures',async()=>{
 const c=setup();await c.confirm(await c.service.createWorkflow(c.m,A,'replay'));
 await runOne({service:c.service,store:c.store,actor:WORKER,owner:'worker',materialize:async c=>c.payload,submit:async()=>{throw new ProtocolError('TRANSACTION_REVERTED','reverted');},now:c.now});
 expect(await c.store.claimJob('next',c.now()+999_999,1000)).toBeNull();
 expect((await c.store.listOperations(c.m.id)).find(o=>o.kind==='provision_escrow')!.operation.status).toBe('failed');
});
it('durably fails materialization errors before a worker intent exists',async()=>{
 const c=setup();await c.confirm(await c.service.createWorkflow(c.m,A,'replay'));
 const submit=vi.fn();
 expect(await runOne({service:c.service,store:c.store,actor:WORKER,owner:'worker',materialize:async()=>{throw new ProtocolError('TERMS_BINDING','mismatched terms');},submit,now:c.now})).toBe('completed');
 const op=(await c.store.listOperations(c.m.id)).find(o=>o.kind==='provision_escrow')!;
 expect(op.operation.status).toBe('failed');expect(op.operation.error?.code).toBe('TERMS_BINDING');
 expect(op.operation.intent).toBeUndefined();expect(submit).not.toHaveBeenCalled();
 expect(await c.store.claimJob('next',c.now()+999999,1000)).toBeNull();
});
