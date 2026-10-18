import { createClient as createGenLayerClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { TransactionHashVariant, type Hash as GenHash } from 'genlayer-js/types';
import { createPublicClient, decodeFunctionData, http, hexToBytes, parseEventLogs, parseAbiItem, erc20Abi, type Abi, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { BASE_CHAIN_ID, GENLAYER_CHAIN_ID, USDC_ADDRESS, canonical, hashBytes, hashText, hashCanonical, participants, ProtocolError, type TransactionIntent, type WorkflowManifest } from '@faultline/protocol';
import type { ChainGateway, Deployment, GatewayCommand, GatewayReceipt } from '@faultline/service';
import escrowAbiJson from '../../../contracts/base/abi/FaultlineBondEscrow.json';
import { jsonValue, matchCall, requireFinalizedGenLayer } from './finality';
import { chainConfig, type ChainConfig } from './config';
export { chainConfig, jsonValue, matchCall, requireFinalizedGenLayer };
export type { ChainConfig };
export const escrowAbi = escrowAbiJson as Abi;
const zero = `0x${'0'.repeat(64)}`;
const optionalHash = (v: unknown): string | undefined => typeof v === 'string' && v !== zero && /^0x[0-9a-f]{64}$/.test(v) ? v : undefined;
const object = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : jsonValue(value);

export function escrowCreateArgs(manifest: WorkflowManifest, genlayerAddress: string): unknown[] {
  const agents = participants(manifest);
  return [manifest.id, hashCanonical(manifest), agents, agents.map(a => manifest.bonds[a]), manifest.repairCap,
    manifest.repairs.map(r => ({id: hashText(r.id), recipient:r.recipient, price:r.price})),
    manifest.nodes.map(n=>hashText(n.id)),manifest.nodes.map(n=>agents.indexOf(n.agent)),String(GENLAYER_CHAIN_ID),genlayerAddress];
}

/** Uses public RPC reads only. Private signing authority is kept in worker / caller-owned signers. */
export class LiveChainGateway implements ChainGateway {
  readonly mode = 'live' as const;
  readonly genlayer;
  readonly base;
  readonly genEvm;
  readonly deployments: Record<'base'|'genlayer', Deployment>;
  constructor(readonly config: ChainConfig) {
    this.genlayer = createGenLayerClient({chain:testnetBradbury,endpoint:config.genlayerRpc});
    this.base = createPublicClient({chain:baseSepolia,transport:http(config.baseRpc,{timeout:15_000,retryCount:1})});
    this.genEvm = createPublicClient({chain:testnetBradbury,transport:http(config.genlayerEvmRpc??config.genlayerRpc,{timeout:15_000,retryCount:1})});
    this.deployments = {genlayer:{chainId:GENLAYER_CHAIN_ID,address:config.genlayerAddress,codeHash:config.genlayerCodeHash,verified:false},base:{chainId:BASE_CHAIN_ID,address:config.escrowAddress,codeHash:config.baseCodeHash,verified:false}};
  }
  async verifyDeployments() {
    const [baseId,genId,baseCode,genCode,token,attestor,genConfig] = await Promise.all([
      this.base.getChainId(),this.genEvm.getChainId(),this.base.getCode({address:this.config.escrowAddress}),this.genlayer.getContractCode(this.config.genlayerAddress),
      this.base.readContract({address:this.config.escrowAddress,abi:escrowAbi,functionName:'USDC'}),this.base.readContract({address:this.config.escrowAddress,abi:escrowAbi,functionName:'attestor'}),this.genlayer.readContract({address:this.config.genlayerAddress,functionName:'get_configuration',args:[],transactionHashVariant:TransactionHashVariant.LATEST_FINAL})]);
    if(baseId!==BASE_CHAIN_ID || genId!==GENLAYER_CHAIN_ID) throw new ProtocolError('WRONG_CHAIN','Faultline v1 only supports Bradbury and Base Sepolia');
    if(!baseCode || hashBytes(hexToBytes(baseCode))!==this.config.baseCodeHash || hashText(genCode)!==this.config.genlayerCodeHash) throw new ProtocolError('DEPLOYMENT_MISMATCH','Deployed contract bytes differ from the approved deployment manifest');
    if(String(token).toLowerCase()!==USDC_ADDRESS.toLowerCase() || String(attestor).toLowerCase()!==this.config.attestor) throw new ProtocolError('DEPLOYMENT_MISMATCH','Escrow token or attestor differs from configuration');
    const nativeConfig=object(genConfig);
    if(nativeConfig.fundingAttestor!==this.config.attestor||nativeConfig.evidenceOrigin!==this.config.evidenceOrigin)throw new ProtocolError('DEPLOYMENT_MISMATCH','GenLayer attestor or evidence origin differs from configuration');
    this.deployments.base.verified=true;this.deployments.genlayer.verified=true;
    return this;
  }
  async prepare(command: GatewayCommand): Promise<TransactionIntent> {
    const {kind,workflow,payload}=command; const id=workflow.manifest.id, p=payload as any;
    let chain:'base'|'genlayer'='genlayer',functionName:string,args:unknown[];
    switch(kind){
      case 'register': functionName='register_workflow';args=[canonical(workflow.manifest)];break;
      case 'accept': functionName='accept_mandate';args=[id];break;
      case 'handoff':functionName='record_handoff';args=[canonical(p)];break;
      case 'acknowledge':functionName='acknowledge_handoff';args=[id,p.handoffId];break;
      case 'report':functionName='open_case';args=[id,canonical({nodeId:p.nodeId,impact:p.impact,reporter:command.actor})];break;
      case 'evidence':functionName='submit_evidence';args=[id,canonical(p)];break;
      case 'close_evidence':functionName='close_evidence';args=[id];break;
      case 'adjudicate':functionName='adjudicate';args=[id,p.snapshotUrl??p.url,p.snapshotHash??p.hash];break;
      case 'repair':functionName='submit_repair';args=[id,p.repairUrl??p.url,p.repairHash??p.hash];break;
      case 'verify_repair':functionName='verify_repair';args=[id];break;
      case 'expire':functionName='expire_workflow';args=[id];break;
      case 'provision_escrow':chain='base';functionName='createWorkflow';args=escrowCreateArgs(workflow.manifest,this.config.genlayerAddress);break;
      case 'fund':chain='base';functionName='depositBond';args=[id];break;
      case 'activate_escrow':chain='base';functionName='activateWorkflow';args=[p.authorization,p.signature];break;
      case 'activate':
        if(p?.authorization){chain='base';functionName='activateWorkflow';args=[p.authorization,p.signature];}
        else {functionName='activate_workflow';args=[id,canonical(p.fundingReceipt??p)];}break;
      case 'open_case_escrow':chain='base';functionName='openCase';args=[id,p.caseId];break;
      case 'reserve':chain='base';functionName='reserveAward';args=[p.authorization,p.classes,p.signature];break;
      case 'payout': case 'withdraw':chain='base';functionName='withdrawFor';args=[id,p.beneficiary];break;
      case 'refund_escrow':chain='base';functionName='refundExpired';args=[id];break;
      case 'release':chain='base';functionName='releaseRepair';args=[p.authorization,p.signature];break;
      default:throw new ProtocolError('UNSUPPORTED_OPERATION',String(kind));
    }
    if(args.some(a=>a===undefined)) throw new ProtocolError('MISSING_PAYLOAD','Operation payload is incomplete');
    return {chain,chainId:this.deployments[chain].chainId,to:this.deployments[chain].address,functionName,args:jsonValue(args),value:'0',...(chain==='base'?{abi:escrowAbi as any[]}: {})};
  }
  async readWorkflow(id:string) {return object(await this.genlayer.readContract({address:this.config.genlayerAddress,functionName:'get_workflow',args:[id],transactionHashVariant:TransactionHashVariant.LATEST_FINAL}));}
  async readCase(id:string) {return object(await this.genlayer.readContract({address:this.config.genlayerAddress,functionName:'get_case',args:[id],transactionHashVariant:TransactionHashVariant.LATEST_FINAL}));}
  async readEscrow(id:string,blockNumber?:bigint) {return jsonValue(await this.base.readContract({address:this.config.escrowAddress,abi:escrowAbi,functionName:'getWorkflow',args:[id],...(blockNumber!==undefined?{blockNumber}:{})}));}
  async nativeAppealStatus(txHash:string){
    const {appealsContract,consensusDataContract}=testnetBradbury;
    if(!appealsContract||!consensusDataContract)throw new ProtocolError('CHAIN_CONFIGURATION','SDK lacks native finality contracts');
    const block=await this.genEvm.getBlock();
    const [canAppeal,finalization,tx]=await Promise.all([
      this.genEvm.readContract({address:appealsContract.address,abi:appealsContract.abi,functionName:'canAppeal',args:[txHash as Hex],blockNumber:block.number}),
      this.genEvm.readContract({address:consensusDataContract.address,abi:consensusDataContract.abi,functionName:'canFinalize',args:[txHash as Hex,block.timestamp],blockNumber:block.number}),
      this.genlayer.getTransaction({hash:txHash as GenHash})]);
    let successfulFinality=false;try{requireFinalizedGenLayer(tx);successfulFinality=true;}catch{/* Eligibility or elapsed time alone never proves successful finality. */}
    return {canAppeal:Boolean(canAppeal),canFinalize:Boolean((finalization as any)[0]),nativeTiming:jsonValue(finalization),observedBlock:String(block.number),status:tx.statusName??'UNKNOWN',successfulFinality};
  }
  async getWithdrawalReceipt(txHash:string,workflowId:string,beneficiary:string):Promise<{intent:TransactionIntent;receipt:GatewayReceipt}|null>{
    const tx=await this.base.getTransaction({hash:txHash as Hex});
    if(tx.to?.toLowerCase()!==this.config.escrowAddress)throw new ProtocolError('WRONG_TRANSACTION','Withdrawal targets another escrow');
    const decoded=decodeFunctionData({abi:escrowAbi,data:tx.input}),args=jsonValue(decoded.args??[]);
    const expected=decoded.functionName==='withdraw'?[workflowId]:[workflowId,beneficiary];
    if(!['withdraw','withdrawFor'].includes(decoded.functionName)||canonical(args)!==canonical(expected)||(decoded.functionName==='withdraw'&&tx.from.toLowerCase()!==beneficiary))throw new ProtocolError('WRONG_TRANSACTION','Withdrawal calldata does not bind the immutable beneficiary');
    const intent:TransactionIntent={chain:'base',chainId:BASE_CHAIN_ID,to:this.config.escrowAddress,functionName:decoded.functionName,args,value:'0',abi:escrowAbi as any[]};
    const receipt=await this.getReceipt(txHash,intent);
    return receipt?{intent,receipt}:null;
  }
  async findWithdrawal(workflowId:Hex,beneficiary:Hex,fromBlock:bigint,toBlock:bigint):Promise<string|null>{
    const event=parseAbiItem('event Withdrawn(bytes32 indexed workflowId, address indexed beneficiary, uint256 amount)');
    // Provider-friendly bounded ranges, newest first. A log is only a lookup hint; the receipt is reverified separately.
    for(let end=toBlock;end>=fromBlock;){
      const start=end-fromBlock>=1999n?end-1999n:fromBlock;
      const logs=await this.base.getLogs({address:this.config.escrowAddress,event,args:{workflowId,beneficiary},fromBlock:start,toBlock:end,strict:true});
      const found=logs.at(-1);if(found?.transactionHash)return found.transactionHash;
      if(start===fromBlock)break;end=start-1n;
    }
    return null;
  }
  async getReceipt(txHash:string,intent:TransactionIntent):Promise<GatewayReceipt|null>{
    if(intent.chainId!==this.deployments[intent.chain].chainId || intent.to.toLowerCase()!==this.deployments[intent.chain].address) throw new ProtocolError('WRONG_DEPLOYMENT','Intent targets an unapproved deployment');
    await this.verifyDeployments();
    if(intent.chain==='genlayer'){
      const tx=await this.genlayer.getTransaction({hash:txHash as GenHash});
      if(tx.statusName!=='FINALIZED') { if(['UNDETERMINED','CANCELED','LEADER_TIMEOUT','VALIDATORS_TIMEOUT'].includes(tx.statusName??'')) throw new ProtocolError('CHAIN_FAILURE',`GenLayer ${tx.statusName}`); return null; }
      requireFinalizedGenLayer(tx);const call=matchCall(tx,intent); const workflowView=await this.readWorkflow(call.workflowId);
      const view=workflowView.caseId ? {...workflowView,...await this.readCase(call.workflowId)} : workflowView;
      const block=await this.genEvm.getBlock({blockNumber:BigInt(tx.readStateBlockRange?.proposalBlock??'0')});
      if(!block.hash || block.number===0n) throw new ProtocolError('RECEIPT_INCOMPLETE','No proposal block is available');
      if(intent.functionName==='adjudicate' && view.snapshotHash!==intent.args[2]) throw new ProtocolError('STALE_DECISION','Finalized view does not match the adjudicated snapshot');
      return {transactionHash:txHash,chain:'genlayer',chainId:GENLAYER_CHAIN_ID,to:this.config.genlayerAddress,from:call.actor,functionName:intent.functionName,argsHash:call.argsHash,value:String(tx.value??0),deploymentHash:this.config.genlayerCodeHash,blockHash:block.hash,blockNumber:String(block.number),execution:'success',finality:'finalized',workflowId:call.workflowId,workflowHash:view.workflowHash??view.hash,caseId:optionalHash(view.caseId),snapshotHash:optionalHash(view.snapshotHash),decisionHash:optionalHash(view.decisionHash),repairHash:optionalHash(view.repairHash),result:view};
    }
    const receipt=await this.base.getTransactionReceipt({hash:txHash as Hex});
    const [tx,finalBlock,includedBlock]=await Promise.all([this.base.getTransaction({hash:txHash as GenHash}),this.base.getBlock({blockTag:'finalized'}),this.base.getBlock({blockNumber:receipt.blockNumber})]);
    if(finalBlock.number<receipt.blockNumber)return null;
    if(includedBlock.hash!==receipt.blockHash || tx.to?.toLowerCase()!==this.config.escrowAddress) throw new ProtocolError('WRONG_TRANSACTION','Base receipt is noncanonical or targets another contract');
    if(receipt.status!=='success') throw new ProtocolError('EXECUTION_FAILED','Finalized Base transaction reverted');
    const decoded=decodeFunctionData({abi:escrowAbi,data:tx.input});const args=jsonValue(decoded.args??[]);
    if(decoded.functionName!==intent.functionName || canonical(args)!==canonical(jsonValue(intent.args)))throw new ProtocolError('WRONG_TRANSACTION','Base calldata differs from the signed intent');
    const authorization = typeof args[0]==='object'?args[0]:undefined;
    const workflowId=authorization?.workflowId??args[0];const view=await this.readEscrow(workflowId,receipt.blockNumber);
    const logs=parseEventLogs({abi:escrowAbi,logs:receipt.logs.filter(l=>l.address.toLowerCase()===this.config.escrowAddress),strict:true});
    const withdrawals=logs.filter(l=>l.eventName==='Withdrawn') as any[];
    const withdrawal=withdrawals[0];
    if(intent.functionName==='withdrawFor'||intent.functionName==='withdraw'){
      const beneficiary=intent.functionName==='withdrawFor'?String(args[1]).toLowerCase():tx.from.toLowerCase();
      if(withdrawals.length!==1||withdrawal.args.workflowId!==workflowId||String(withdrawal.args.beneficiary).toLowerCase()!==beneficiary||withdrawal.args.amount<=0n)throw new ProtocolError('WITHDRAWAL_MISSING','Withdrawal must bind the workflow, fixed beneficiary and a positive amount');
    }
    const transfers=parseEventLogs({abi:erc20Abi,logs:receipt.logs.filter(l=>l.address.toLowerCase()===USDC_ADDRESS.toLowerCase()),strict:true});
    const usdcTransferVerified=Boolean(withdrawal&&transfers.some(l=>l.eventName==='Transfer'&&l.args.from.toLowerCase()===this.config.escrowAddress&&l.args.to.toLowerCase()===String(withdrawal.args.beneficiary).toLowerCase()&&l.args.value===withdrawal.args.amount));
    if(withdrawal&&!usdcTransferVerified)throw new ProtocolError('TOKEN_TRANSFER_MISSING','Escrow withdrawal lacks the matching USDC Transfer event');
    const deposit=logs.find(l=>l.eventName==='BondDeposited') as any;
    return {transactionHash:txHash,chain:'base',chainId:BASE_CHAIN_ID,to:this.config.escrowAddress,from:tx.from.toLowerCase(),functionName:intent.functionName,argsHash:hashCanonical(args),value:String(tx.value),deploymentHash:this.config.baseCodeHash,blockHash:receipt.blockHash,blockNumber:String(receipt.blockNumber),execution:'success',finality:'finalized',workflowId,workflowHash:view.workflowHash,caseId:optionalHash(view.caseId),snapshotHash:optionalHash(authorization?.snapshotHash??view.reservationSnapshotHash),decisionHash:optionalHash(authorization?.decisionId??view.reservationDecisionId),repairHash:optionalHash(view.repairHash),result:{...view,...(withdrawal?{beneficiary:String(withdrawal.args.beneficiary).toLowerCase(),withdrawnAmount:String(withdrawal.args.amount),usdcTransferVerified}:{}),...(deposit?{amount:String(deposit.args.amount)}:{}),events:jsonValue(logs)}};
  }
  async getReputation(agent:string){return Promise.all(['software','research','procurement'].map(async domain=>({domain,value:object(await this.genlayer.readContract({address:this.config.genlayerAddress,functionName:'get_reputation',args:[agent,domain],transactionHashVariant:TransactionHashVariant.LATEST_FINAL}))})));}
  async usdcBalance(address:Hex){return this.base.readContract({address:USDC_ADDRESS,abi:erc20Abi,functionName:'balanceOf',args:[address]});}
}
