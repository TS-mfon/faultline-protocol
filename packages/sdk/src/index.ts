import { BASE_CHAIN_ID, GENLAYER_CHAIN_ID, USDC_ADDRESS, AddressSchema, HashSchema, ProtocolError, type WorkflowManifest, type WorkflowRecord, type Operation, type TransactionIntent, type HandoffManifest, type RepairSubmission, type EvidenceSnapshot } from '@faultline/protocol';
import { erc20Abi } from 'viem';
export class FaultlineApiError extends Error {constructor(public code:string,message:string,public status:number){super(message);}}
export interface ClientOptions {baseUrl:string;token?:string;fetch?:typeof fetch;}
export interface MutationOptions {idempotencyKey?:string;}
export type IntentSigner=(intent:TransactionIntent)=>Promise<string>;
export class FaultlineClient {
  private fetcher:typeof fetch;private base:string;private token?:string;
  constructor(options:ClientOptions){const u=new URL(options.baseUrl);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw new Error('API requires HTTPS except local development');if(u.username||u.password||u.search||u.hash)throw new Error('Invalid API URL');this.base=options.baseUrl.replace(/\/$/,'');this.token=options.token;this.fetcher=options.fetch??fetch;}
  setToken(token:string|undefined){this.token=token;}
  async request<T>(path:string,body?:unknown,options:MutationOptions={}):Promise<T>{
    const write=body!==undefined;const key=options.idempotencyKey??crypto.randomUUID();
    const headers:Record<string,string>={Accept:'application/json',...(this.token?{Authorization:`Bearer ${this.token}`}:{})};
    if(write){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;}
    const response=await this.fetcher(`${this.base}${path}`,{method:write?'POST':'GET',headers,...(write?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30_000)});
    const value=await response.json() as {data?:T;error?:{code:string;message:string}};
    if(!response.ok||value.error)throw new FaultlineApiError(value.error?.code??'HTTP_ERROR',value.error?.message??`HTTP ${response.status}`,response.status);
    if(!('data' in value))throw new FaultlineApiError('INVALID_RESPONSE','Response envelope is missing data',502);return value.data as T;
  }
  putArtifact(text:string,o?:MutationOptions){return this.request<{hash:string}>('/artifacts',{text},o);}
  listWorkflows(){return this.request<WorkflowRecord[]>('/workflows');}
  getWorkflow(id:string){return this.request<WorkflowRecord>(`/workflows/${HashSchema.parse(id)}`);}
  createWorkflow(manifest:WorkflowManifest,o?:MutationOptions){return this.request<Operation>('/workflows',{manifest},o);}
  action(id:string,action:string,payload:unknown={},o?:MutationOptions){if(!['accept','fund','handoffs','acknowledgments','failures','evidence','close-evidence','adjudicate','repairs'].includes(action))throw new Error('Unsupported workflow action');return this.request<Operation>(`/workflows/${HashSchema.parse(id)}/${action}`,payload,o);}
  accept(id:string,o?:MutationOptions){return this.action(id,'accept',{},o);}
  fund(id:string,o?:MutationOptions){return this.action(id,'fund',{},o);}
  publishHandoff(id:string,h:HandoffManifest,o?:MutationOptions){return this.action(id,'handoffs',h,o);}
  acknowledge(id:string,handoffId:string,o?:MutationOptions){return this.action(id,'acknowledgments',{handoffId},o);}
  reportFailure(id:string,report:{nodeId:string;impact:string},o?:MutationOptions){return this.action(id,'failures',report,o);}
  addEvidence(id:string,e:EvidenceSnapshot['evidence'][number],o?:MutationOptions){return this.action(id,'evidence',e,o);}
  closeEvidence(id:string,o?:MutationOptions){return this.action(id,'close-evidence',{},o);}
  adjudicate(id:string,o?:MutationOptions){return this.action(id,'adjudicate',{},o);}
  submitRepair(id:string,submission:RepairSubmission,o?:MutationOptions){return this.action(id,'repairs',submission,o);}
  getOperation(id:string){return this.request<Operation>(`/operations/${HashSchema.parse(id)}`);}
  getOperationFinality(id:string){return this.request<{supported:boolean;mode:'live'|'replay';transactionHash?:string;canAppeal?:boolean;canFinalize?:boolean;status?:string;successfulFinality?:boolean;observedBlock?:string}>(`/operations/${HashSchema.parse(id)}/finality`);}
  confirmOperation(id:string,txHash:string,o?:MutationOptions){return this.request<Operation>(`/operations/${HashSchema.parse(id)}/confirm`,{txHash:HashSchema.parse(txHash)},o);}
  audit(id:string){return this.request<any>(`/workflows/${HashSchema.parse(id)}/audit`);}
  reputation(address:string){return this.request<unknown>(`/agents/${AddressSchema.parse(address)}/reputation`);}
  challenge(address:string){return this.request<{id:string;message:string;expiresAt:number}>('/auth/challenge',{address:AddressSchema.parse(address)});}
  async authenticate(address:string,signMessage:(message:string)=>Promise<string>){const challenge=await this.challenge(address);const signature=await signMessage(challenge.message);const auth=await this.request<{token:string;address:string;expiresAt:number}>('/auth/verify',{id:challenge.id,signature});this.token=auth.token;return auth;}
  async submitOperation(op:Operation,signer:IntentSigner):Promise<Operation>{
    if(op.status==='completed'||op.status==='failed')return op;
    if(op.txHash)return this.confirmOperation(op.id,op.txHash,{idempotencyKey:`confirm-${op.id}`});
    if(op.status!=='awaiting_signature'||!op.intent)throw new ProtocolError('NOT_SIGNABLE','Only an awaiting_signature operation can be signed by the caller');
    const i=op.intent; if(i.chainId!==(i.chain==='base'?BASE_CHAIN_ID:GENLAYER_CHAIN_ID))throw new ProtocolError('WRONG_CHAIN','Faultline supports testnets only');AddressSchema.parse(i.to);
    const txHash=await signer(i);return this.confirmOperation(op.id,HashSchema.parse(txHash),{idempotencyKey:`confirm-${op.id}`});
  }
}
/** Exact approval, separate from deposit; the caller must review and sign it. */
export function bondApproval(escrow:string,amount:string):TransactionIntent{if(!/^[1-9][0-9]{0,23}$/.test(amount))throw new Error('Invalid bond amount');return {chain:'base',chainId:BASE_CHAIN_ID,to:USDC_ADDRESS,functionName:'approve',args:[AddressSchema.parse(escrow),amount],value:'0',abi:[...erc20Abi]};}

export const actions = ['create','accept','fund','handoff','acknowledge','report','evidence','close_evidence','adjudicate','repair','confirm'] as const;
export type Action = typeof actions[number];
/** Common adapter boundary. No adapter accepts a key or signs an intent. */
export function dispatch(client: FaultlineClient, action: Action, args: Record<string,any>, idempotencyKey: string): Promise<Operation> {
  if(!/^[\w:.-]{1,128}$/.test(idempotencyKey))throw new ProtocolError('INVALID_IDEMPOTENCY_KEY','Provide a stable request key');
  const options={idempotencyKey};
  switch(action){
    case 'create':return client.createWorkflow(args.manifest,options);
    case 'accept':return client.accept(args.workflowId,options);
    case 'fund':return client.fund(args.workflowId,options);
    case 'handoff':return client.publishHandoff(args.workflowId,args.handoff,options);
    case 'acknowledge':return client.acknowledge(args.workflowId,args.handoffId,options);
    case 'report':return client.reportFailure(args.workflowId,args.report,options);
    case 'evidence':return client.addEvidence(args.workflowId,args.evidence,options);
    case 'close_evidence':return client.closeEvidence(args.workflowId,options);
    case 'adjudicate':return client.adjudicate(args.workflowId,options);
    case 'repair':return client.submitRepair(args.workflowId,args.repair,options);
    case 'confirm':return client.confirmOperation(args.operationId,args.txHash,options);
    default:throw new ProtocolError('UNSUPPORTED_ACTION','Unknown Faultline action');
  }
}
