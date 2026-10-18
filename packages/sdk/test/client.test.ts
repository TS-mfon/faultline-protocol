import {it,expect,vi} from 'vitest';
import {FaultlineClient,bondApproval,dispatch} from '../src';
import {hashText, type Operation} from '@faultline/protocol';
const id=hashText('operation');
const operation:Operation={id,kind:'accept',status:'awaiting_signature',createdAt:'2026-10-15T00:00:00Z',updatedAt:'2026-10-15T00:00:00Z',intent:{chain:'genlayer',chainId:4221,to:`0x${'1'.repeat(40)}`,functionName:'accept_mandate',args:[id]}};
it('forwards bearer and stable mutation key; errors do not trigger unsafe automatic retries',async()=>{
 const fetcher=vi.fn(async()=>Response.json({error:{code:'IDEMPOTENCY_CONFLICT',message:'Changed request'}},{status:409}));
 const client=new FaultlineClient({baseUrl:'https://faultline.test/api/v1',token:'test-session',fetch:fetcher});
 await expect(dispatch(client,'accept',{workflowId:id},'same-operation')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT',status:409});
 expect(fetcher).toHaveBeenCalledTimes(1);const init=fetcher.mock.calls[0] as unknown as [string,RequestInit];
 expect(init[1].headers).toMatchObject({Authorization:'Bearer test-session','Idempotency-Key':'same-operation'});
});
it('never signs a submitted operation twice and separates exact USDC approval',async()=>{
 const fetcher=vi.fn(async()=>Response.json({data:{...operation,status:'confirming'}})),sign=vi.fn();
 const client=new FaultlineClient({baseUrl:'https://faultline.test/api/v1',fetch:fetcher});
 await client.submitOperation({...operation,status:'submitted',txHash:hashText('tx')},sign);expect(sign).not.toHaveBeenCalled();
 expect(bondApproval(operation.intent!.to,'12000000')).toMatchObject({chainId:84532,functionName:'approve',args:[operation.intent!.to,'12000000']});
 await expect(client.submitOperation({...operation,intent:{...operation.intent!,chainId:1}},sign)).rejects.toMatchObject({code:'WRONG_CHAIN'});
 expect(sign).not.toHaveBeenCalled();
});
it('rejects credential-bearing and insecure API endpoints',()=>{for(const baseUrl of ['http://example.com','https://user:password@example.com','https://example.com/?token=x'])expect(()=>new FaultlineClient({baseUrl})).toThrow();});
