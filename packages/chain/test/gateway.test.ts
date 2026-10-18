import {describe,expect,it,vi} from 'vitest';
import {encodeAbiParameters,encodeEventTopics,encodeFunctionData,erc20Abi,type Hex} from 'viem';
import {hashCanonical,hashText,USDC_ADDRESS,type TransactionIntent} from '@faultline/protocol';
import {LiveChainGateway,escrowAbi,type ChainConfig} from '../src';

const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Hex;
const escrow=address(40),beneficiary=address(3),sender=address(9),workflowId=hashText('gateway fixture');
const txHash=hashText('withdrawal fixture') as Hex,blockHash=hashText('included fixture block') as Hex;
const config:ChainConfig={baseRpc:'https://base.example.test',genlayerRpc:'https://genlayer.example.test',evidenceOrigin:'https://example.test/api/v1/evidence',escrowAddress:escrow,genlayerAddress:address(41),baseCodeHash:hashText('base fixture'),genlayerCodeHash:hashText('genlayer fixture'),attestor:sender};

function context() {
  const gateway=new LiveChainGateway(config);
  vi.spyOn(gateway,'verifyDeployments').mockResolvedValue(gateway);
  vi.spyOn(gateway,'readEscrow').mockResolvedValue({state:5,workflowHash:hashText('manifest fixture')});
  const intent:TransactionIntent={chain:'base',chainId:84532,to:escrow,functionName:'withdrawFor',args:[workflowId,beneficiary],value:'0'};
  const withdrawal={address:escrow,topics:encodeEventTopics({abi:escrowAbi,eventName:'Withdrawn',args:{workflowId,beneficiary}}),data:encodeAbiParameters([{type:'uint256'}],[750000n])};
  const transfer={address:USDC_ADDRESS as Hex,topics:encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:escrow,to:beneficiary}}),data:encodeAbiParameters([{type:'uint256'}],[750000n])};
  const receipt={status:'success',blockHash,blockNumber:100n,logs:[withdrawal,transfer]};
  vi.spyOn(gateway.base,'getTransactionReceipt').mockImplementation(async()=>receipt as any);
  vi.spyOn(gateway.base,'getTransaction').mockResolvedValue({from:sender,to:escrow,input:encodeFunctionData({abi:escrowAbi,functionName:'withdrawFor',args:intent.args}),value:0n} as any);
  const getBlock=vi.spyOn(gateway.base,'getBlock').mockResolvedValue({number:100n,hash:blockHash} as any);
  return {gateway,intent,receipt,withdrawal,transfer,getBlock};
}

describe('Base receipt verification with mocked RPC responses',()=>{
  it('discovers an observed self-withdrawal and rechecks the original token receipt',async()=>{
    const c=context();
    vi.spyOn(c.gateway.base,'getTransaction').mockResolvedValue({from:beneficiary,to:escrow,input:encodeFunctionData({abi:escrowAbi,functionName:'withdraw',args:[workflowId]}),value:0n} as any);
    expect(await c.gateway.getWithdrawalReceipt(txHash,workflowId,beneficiary)).toMatchObject({intent:{functionName:'withdraw',args:[workflowId]},receipt:{from:beneficiary,result:{beneficiary,usdcTransferVerified:true}}});
    await expect(c.gateway.getWithdrawalReceipt(txHash,workflowId,address(5))).rejects.toMatchObject({code:'WRONG_TRANSACTION'});
    c.receipt.logs=[c.withdrawal];
    await expect(c.gateway.getWithdrawalReceipt(txHash,workflowId,beneficiary)).rejects.toMatchObject({code:'TOKEN_TRANSFER_MISSING'});
  });
  it('searches withdrawal logs in bounded ranges and returns only a lookup hint',async()=>{
    const c=context();
    const logs=vi.spyOn(c.gateway.base,'getLogs').mockResolvedValueOnce([]).mockResolvedValueOnce([{transactionHash:txHash}] as any);
    expect(await c.gateway.findWithdrawal(workflowId,beneficiary,100n,4500n)).toBe(txHash);
    expect(logs.mock.calls.map(([args])=>[args?.fromBlock,args?.toBlock])).toEqual([[2501n,4500n],[501n,2500n]]);
  });
  it('does not turn native finalization eligibility into successful finality',async()=>{
    const c=context();
    vi.spyOn(c.gateway.genEvm,'getBlock').mockResolvedValue({number:100n,timestamp:1900000000n} as any);
    vi.spyOn(c.gateway.genEvm,'readContract').mockImplementation(async(args:any)=>args.functionName==='canAppeal'?true:[true,1n,2n]);
    const transaction=vi.spyOn(c.gateway.genlayer,'getTransaction').mockResolvedValue({statusName:'ACCEPTED'} as any);
    expect(await c.gateway.nativeAppealStatus(txHash)).toMatchObject({canAppeal:true,canFinalize:true,successfulFinality:false,observedBlock:'100'});
    transaction.mockResolvedValue({statusName:'FINALIZED',txExecutionResultName:'FINISHED_WITH_ERROR',resultName:'AGREE'} as any);
    expect((await c.gateway.nativeAppealStatus(txHash)).successfulFinality).toBe(false);
  });
  it('requires a canonical finalized withdrawal with exact calldata and matching token event',async()=>{
    const {gateway,intent}=context();const receipt=await gateway.getReceipt(txHash,intent);
    expect(receipt).toMatchObject({transactionHash:txHash,workflowId,argsHash:hashCanonical(intent.args),execution:'success',finality:'finalized',result:{beneficiary,withdrawnAmount:'750000',usdcTransferVerified:true}});
  });
  it.each(['missing withdrawal','wrong workflow','wrong beneficiary','missing transfer','wrong token','wrong amount','wrong sender'])('rejects %s evidence',async fault=>{
    const c=context();
    if(fault==='missing withdrawal')c.receipt.logs=[c.transfer];
    if(fault==='wrong workflow')c.withdrawal.topics=encodeEventTopics({abi:escrowAbi,eventName:'Withdrawn',args:{workflowId:hashText('different workflow'),beneficiary}});
    if(fault==='wrong beneficiary')c.withdrawal.topics=encodeEventTopics({abi:escrowAbi,eventName:'Withdrawn',args:{workflowId,beneficiary:address(4)}});
    if(fault==='missing transfer')c.receipt.logs=[c.withdrawal];
    if(fault==='wrong token')c.transfer.address=address(99);
    if(fault==='wrong amount')c.transfer.data=encodeAbiParameters([{type:'uint256'}],[1n]);
    if(fault==='wrong sender')c.transfer.topics=encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:address(99),to:beneficiary}});
    await expect(c.gateway.getReceipt(txHash,c.intent)).rejects.toThrow();
  });
  it('does not finalize a success or failure while its block is pending',async()=>{
    const c=context();c.getBlock.mockImplementation(async args=>({number:args?.blockTag==='finalized'?99n:100n,hash:blockHash}) as any);
    expect(await c.gateway.getReceipt(txHash,c.intent)).toBeNull();
    c.receipt.status='reverted';expect(await c.gateway.getReceipt(txHash,c.intent)).toBeNull();
    c.getBlock.mockResolvedValue({number:100n,hash:blockHash} as any);
    await expect(c.gateway.getReceipt(txHash,c.intent)).rejects.toMatchObject({code:'EXECUTION_FAILED'});
  });
  it('rejects noncanonical blocks and altered signed arguments',async()=>{
    const c=context();c.getBlock.mockResolvedValue({number:100n,hash:hashText('reorg')} as any);
    await expect(c.gateway.getReceipt(txHash,c.intent)).rejects.toMatchObject({code:'WRONG_TRANSACTION'});
    c.getBlock.mockResolvedValue({number:100n,hash:blockHash} as any);
    await expect(c.gateway.getReceipt(txHash,{...c.intent,args:[workflowId,address(4)]})).rejects.toMatchObject({code:'WRONG_TRANSACTION'});
  });
});
