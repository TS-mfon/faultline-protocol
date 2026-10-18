import { describe, expect, it, vi } from 'vitest';
import { createHttpHandler, bodyJson } from '../../apps/web/lib/http';
import { MemoryStore, WalletAuth } from '@faultline/service';
import { privateKeyToAccount } from 'viem/accounts';
const account=privateKeyToAccount(`0x${'1'.repeat(64)}`);
const url='https://faultline.test/api/v1';
const post=(path:string,data:unknown,headers:Record<string,string>={})=>new Request(`${url}/${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});
describe('HTTP wallet and persistence boundary',()=>{
 it('reports missing live configuration honestly',async()=>{const handler=createHttpHandler(async()=>null);const r=await handler(post('workflows',{}));expect(r.status).toBe(503);expect((await r.json()).error.code).toBe('NOT_CONFIGURED');});
 it('enforces byte limits even without content-length',async()=>{await expect(bodyJson(post('evidence',{text:'é'.repeat(33_000)}))).rejects.toMatchObject({code:'BODY_TOO_LARGE'});});
 it('uses authenticated actor and requires idempotency before dispatch',async()=>{
   const store=new MemoryStore({purpose:'test'}), auth=new WalletAuth(store,{secret:'local-test-secret-only-'.repeat(3),origin:'https://faultline.test',audience:'faultline-api-v1'});
   const challenge=await auth.createChallenge(account.address), signature=await account.signMessage({message:challenge.message}), token=await auth.verifyChallenge(challenge.id,signature);
   const createWorkflow=vi.fn(async()=>({status:'awaiting_signature'})); const service={createWorkflow,withIdempotency:async(_key:string,fn:()=>unknown)=>fn()};
   const handler=createHttpHandler(async()=>({service,store,auth}) as any);
   expect((await handler(post('workflows',{}))).status).toBe(401);
   expect((await handler(post('workflows',{}, {authorization:`Bearer ${token.token}`}))).status).toBe(400);
   const body={manifest:{title:'test'},actor:`0x${'2'.repeat(40)}`,mode:'replay'};
   const r=await handler(post('workflows',body,{authorization:`Bearer ${token.token}`,'idempotency-key':'test-create-1'}));
   expect(r.status).toBe(202); expect(createWorkflow).toHaveBeenCalledWith(body.manifest,account.address.toLowerCase(),'live');
   await expect(auth.verifyChallenge(challenge.id,signature)).rejects.toMatchObject({code:'INVALID_CHALLENGE'});
 });
});
