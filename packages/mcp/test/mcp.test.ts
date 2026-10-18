import {it,expect,vi} from 'vitest';
import {handleMcp} from '../src';
import {FaultlineClient} from '@faultline/sdk';
import {hashText} from '@faultline/protocol';
const request=(method:string,params:unknown,id=1)=>new Request('https://faultline.test/api/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
it('negotiates MCP and lists real tools through the SDK transport',async()=>{
 const client=new FaultlineClient({baseUrl:'https://faultline.test/api/v1'});
 const init=await handleMcp(request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}),client);
 expect(init.status).toBe(200);expect((await init.json()).result.protocolVersion).toBe('2025-11-25');
 const list=await handleMcp(request('tools/list',{}),client);expect(list.status).toBe(200);
 expect((await list.json()).result.tools.map((t:any)=>t.name)).toContain('faultline_action');
});
it('isolates per-request bearer authority and leaves signatures to callers',async()=>{
 const fetcher=vi.fn(async()=>Response.json({data:{status:'awaiting_signature',intent:{functionName:'accept_mandate'}}}));
 for(const token of ['wallet-A','wallet-B']){
   const response=await handleMcp(request('tools/call',{name:'faultline_action',arguments:{action:'accept',args:{workflowId:hashText('workflow')},idempotencyKey:'same-key'}}),new FaultlineClient({baseUrl:'https://faultline.test/api/v1',token,fetch:fetcher}));
   expect((await response.json()).result.structuredContent.data.status).toBe('awaiting_signature');
 }
 const calls=fetcher.mock.calls as unknown as [string,RequestInit][];
 expect(calls.map(x=>(x[1].headers as Record<string,string>).Authorization)).toEqual(['Bearer wallet-A','Bearer wallet-B']);
});
