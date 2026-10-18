import { abi as genAbi } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { createPublicClient, createWalletClient, encodeFunctionData, keccak256, parseEventLogs, http, type Hex, type LocalAccount, type Abi } from 'viem';
import { baseSepolia } from 'viem/chains';
import { ProtocolError, USDC_ADDRESS, hashCanonical, type TransactionIntent } from '@faultline/protocol';
import type { Collection, Db } from 'mongodb';
import type { ChainConfig } from '@faultline/chain';
export interface SignedRecord { _id:string; intentHash:string; chainId:number; from:string; nonce:number; raw:Hex; evmHash:Hex; logicalHash?:string; }
export interface SigningJournal { get(id:string):Promise<SignedRecord|null>; latest(chainId:number,from:string):Promise<SignedRecord|null>; latestNonce(chainId:number,from:string):Promise<number>; insert(record:SignedRecord):Promise<SignedRecord>; setLogicalHash(id:string,hash:string):Promise<void>; }
export class MongoSigningJournal implements SigningJournal {
  private c:Collection<SignedRecord>;
  constructor(db:Db){this.c=db.collection<SignedRecord>('faultline_signed_transactions');}
  async initialize(){await this.c.createIndex({chainId:1,from:1,nonce:1},{unique:true});}
  get(id:string){return this.c.findOne({_id:id});}
  latest(chainId:number,from:string){return this.c.find({chainId,from}).sort({nonce:-1}).limit(1).next();}
  async latestNonce(chainId:number,from:string){return (await this.latest(chainId,from))?.nonce??-1;}
  async insert(record:SignedRecord){try{await this.c.insertOne(record);return record;}catch(e){const old=await this.get(record._id);if(old&&old.intentHash===record.intentHash)return old;throw e;}}
  async setLogicalHash(id:string,hash:string){const result=await this.c.updateOne({_id:id,$or:[{logicalHash:{$exists:false}},{logicalHash:hash}]},{$set:{logicalHash:hash}});if(!result.matchedCount)throw new ProtocolError('TRANSACTION_CONFLICT','Journal already binds another transaction');}
}
/** Save exact signed bytes BEFORE any broadcast; retry only those bytes after crashes. */
export async function journalOnce(journal:SigningJournal,id:string,intent:TransactionIntent,sign:()=>Promise<SignedRecord>):Promise<SignedRecord>{
  const old=await journal.get(id);if(old){if(old.intentHash!==hashCanonical(intent))throw new ProtocolError('INTENT_IMMUTABLE','Signed intent cannot change');return old;}
  const record=await sign();if(record._id!==id||record.intentHash!==hashCanonical(intent)||keccak256(record.raw)!==record.evmHash)throw new ProtocolError('BAD_SIGNED_RECORD','Signer returned inconsistent bytes');return journal.insert(record);
}
export class DurableSigner {
  constructor(readonly config:ChainConfig,readonly account:LocalAccount,readonly journal:SigningJournal,readonly approval?:{spender:string;amount:string}){}
  async submit(id:string,intent:TransactionIntent):Promise<string|null>{
    const chain=intent.chain==='base'?baseSepolia:testnetBradbury;
    const rpc=intent.chain==='base'?this.config.baseRpc:this.config.genlayerEvmRpc??this.config.genlayerRpc;
    const exactApproval=intent.chain==='base'&&intent.to.toLowerCase()===USDC_ADDRESS.toLowerCase()&&intent.functionName==='approve'&&this.approval&&hashCanonical(intent.args)===hashCanonical([this.approval.spender,this.approval.amount]);
    if(BigInt(intent.value??'0')!==0n||intent.chainId!==chain.id||(!exactApproval&&intent.to.toLowerCase()!==(intent.chain==='base'?this.config.escrowAddress:this.config.genlayerAddress)))throw new ProtocolError('WRONG_CHAIN','Worker intent is outside the approved deployments');
    const pub=createPublicClient({chain,transport:http(rpc,{timeout:15000,retryCount:0})});
    const wallet=createWalletClient({chain,account:this.account,transport:http(rpc,{timeout:15000,retryCount:0})});
    const record=await journalOnce(this.journal,id,intent,async()=>{
      let to=intent.to as Hex,data:Hex;
      if(intent.chain==='base')data=encodeFunctionData({abi:intent.abi as Abi,functionName:intent.functionName,args:intent.args});
      else {
        const consensus=testnetBradbury.consensusMainContract;if(!consensus)throw new ProtocolError('CHAIN_CONFIGURATION','SDK lacks the Bradbury consensus contract');
        to=consensus.address;
        const calldata=genAbi.transactions.serialize([genAbi.calldata.encode(genAbi.calldata.makeCalldataObject(intent.functionName,intent.args as any,undefined)),false]);
        const block=await pub.getBlock();
        data=encodeFunctionData({abi:consensus.abi,functionName:'addTransaction',args:[this.account.address,intent.to,BigInt(testnetBradbury.defaultNumberOfInitialValidators),BigInt(testnetBradbury.defaultConsensusMaxRotations),calldata,block.timestamp+3600n] as any});
      }
      const nonce=Math.max(await pub.getTransactionCount({address:this.account.address,blockTag:'pending'}),(await this.journal.latestNonce(chain.id,this.account.address.toLowerCase()))+1);
      const request=await wallet.prepareTransactionRequest({account:this.account,chain,to,data,nonce,value:BigInt(intent.value??'0'),...(intent.chain==='genlayer'?{type:'legacy' as const}:{})});
      const raw=await this.account.signTransaction(request as any);
      return {_id:id,intentHash:hashCanonical(intent),chainId:chain.id,from:this.account.address.toLowerCase(),nonce,raw,evmHash:keccak256(raw)};
    });
    if(record.logicalHash)return record.logicalHash;
    let receipt;
    try{receipt=await pub.getTransactionReceipt({hash:record.evmHash});}catch(error){if(!String(error).includes('could not be found')&&!String(error).includes('not found'))throw error;}
    if(!receipt){try{await pub.sendRawTransaction({serializedTransaction:record.raw});}catch(error){if(!/already known|known transaction|nonce too low/i.test(String(error)))throw error;}return intent.chain==='base'?record.evmHash:null;}
    if(receipt.status!=='success')throw new ProtocolError('TRANSACTION_REVERTED',`Broadcast transaction ${record.evmHash} reverted; never re-sign this operation`);
    let hash:string=record.evmHash;
    if(intent.chain==='genlayer'){
      const contract=testnetBradbury.consensusMainContract!;
      const logs=parseEventLogs({abi:contract.abi,logs:receipt.logs.filter(l=>l.address.toLowerCase()===contract.address.toLowerCase())});
      const event=logs.find((l:any)=>l.eventName==='NewTransaction'||l.eventName==='CreatedTransaction') as any;
      if(!event?.args?.txId)throw new ProtocolError('CONSENSUS_EVENT_MISSING','Successful EVM submission has no GenLayer application transaction');
      hash=event.args.txId;
    }
    await this.journal.setLogicalHash(id,hash);return hash;
  }
}
