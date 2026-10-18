import { describe, expect, it } from 'vitest';
import { requireFinalizedGenLayer, matchCall } from '../../packages/chain/src/finality';
const id=`0x${'1'.repeat(64)}`, address=`0x${'2'.repeat(40)}`;
const good = { statusName:'FINALIZED', txExecutionResultName:'FINISHED_WITH_RETURN', resultName:'MAJORITY_AGREE', recipient:address, sender:address, txDataDecoded:{type:'call',leaderOnly:false,callData:{method:'verify_repair',args:[id]}} } as any;
describe('native finality boundary',()=>{
 it('requires finalized AND successful execution AND consensus',()=>{expect(()=>requireFinalizedGenLayer(good)).not.toThrow(); for(const statusName of ['ACCEPTED','READY_TO_FINALIZE','UNDETERMINED','CANCELED']) expect(()=>requireFinalizedGenLayer({...good,statusName})).toThrow(); expect(()=>requireFinalizedGenLayer({...good,txExecutionResultName:'FINISHED_WITH_ERROR'})).toThrow(); expect(()=>requireFinalizedGenLayer({...good,resultName:'NO_MAJORITY'})).toThrow(); expect(()=>requireFinalizedGenLayer({...good,txDataDecoded:{...good.txDataDecoded,leaderOnly:true}})).toThrow(); });
 it('binds contract, exact method, args and workflow',()=>{const intent={chain:'genlayer',chainId:4221,to:address,functionName:'verify_repair',args:[id]} as const;expect(matchCall(good,{...intent,args:[id]}).workflowId).toBe(id);expect(()=>matchCall(good,{...intent,args:[`0x${'3'.repeat(64)}`]})).toThrow();expect(()=>matchCall(good,{...intent,args:[id],functionName:'adjudicate'})).toThrow();});
});
