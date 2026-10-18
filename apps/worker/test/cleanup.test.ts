import {describe,expect,it,vi} from 'vitest';
import {hashText} from '@faultline/protocol';
import {scheduleCleanup} from '../src/cleanup';
import {manifest,A,B,R,WORKER,addr} from '../../../packages/service/test/fixtures';

// Synthetic finalized-state inputs exercise scheduling only, never live payment claims.
function context(status: string, state=5) {
  const m=manifest();m.repairs.push({...m.repairs[0],id:'alternative',recipient:addr(4)});
  const record={manifest:m,mode:'live',status:'verifying_repair',expiresAt:new Date(2000000000000).toISOString()};
  const store={listWorkflows:async()=>[{record,escrowReady:true}],listOperations:async()=>[{kind:'payout',payload:{beneficiary:R},operation:{status}}]};
  const service={queueCleanup:vi.fn(async()=>({id:hashText('cleanup')}))};
  const readContract=vi.fn(async()=>[0n,0n,1n,0n,1n]);
  const gateway={base:{getBlock:async()=>({number:123n,timestamp:1900000000n}),readContract},readEscrow:async()=>({state,hardDeadline:1800000000,repairDeadline:1800000000}),config:{escrowAddress:addr(40)}};
  return {m,record,store,service,gateway};
}

describe('matured cleanup scheduling',()=>{
  it('reserves only the active payout beneficiary for its dedicated job',async()=>{
    const c=context('confirming');
    await scheduleCleanup(c.store as any,c.service as any,c.gateway as any,WORKER);
    const recipients=c.service.queueCleanup.mock.calls.map(call=>(call as unknown[])[3]);
    expect(recipients).toEqual([A,B,addr(4)]);expect(recipients).not.toContain(R);
  });
  it.each(['failed','completed'])('allows withdrawal cleanup after a %s payout job',async status=>{
    const c=context(status);
    await scheduleCleanup(c.store as any,c.service as any,c.gateway as any,WORKER);
    expect(c.service.queueCleanup).toHaveBeenCalledWith(c.m.id,'withdraw',WORKER,R);
  });
  it('queues matured refunds even when the application case is terminal',async()=>{
    const c=context('failed',4);c.record.status='recovery_failed';
    await scheduleCleanup(c.store as any,c.service as any,c.gateway as any,WORKER);
    expect(c.service.queueCleanup).toHaveBeenCalledWith(c.m.id,'refund_escrow',WORKER);
    expect(c.gateway.base.readContract).not.toHaveBeenCalled();
  });
  it('reconciles zero credit against the actual finalized withdrawal even when a payout job is pending',async()=>{
    const c=context('confirming');
    Object.assign(c.record,{decision:{remedyId:'correct'}});
    c.gateway.base.readContract.mockResolvedValue([1n,1n,0n,0n,0n]);
    c.store.listWorkflows=async()=>[{record:c.record,escrowReady:true,receipts:[{chain:'base',functionName:'releaseRepair',blockNumber:'100'}]}] as any;
    const findWithdrawal=vi.fn(async()=>hashText('external withdrawal')),reconcileWithdrawal=vi.fn(async()=>null);
    Object.assign(c.gateway,{findWithdrawal});Object.assign(c.service,{reconcileWithdrawal});
    await scheduleCleanup(c.store as any,c.service as any,c.gateway as any,WORKER);
    expect(reconcileWithdrawal).toHaveBeenCalledWith(c.m.id,hashText('external withdrawal'),R,WORKER);
    expect(findWithdrawal).toHaveBeenCalledWith(c.m.id,R,100n,123n);
    expect(c.service.queueCleanup).not.toHaveBeenCalled();
  });
});
