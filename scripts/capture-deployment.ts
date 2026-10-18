import {readFile} from 'node:fs/promises';
import {createClient} from 'genlayer-js';
import {testnetBradbury} from 'genlayer-js/chains';
import {createPublicClient,http,hexToBytes} from 'viem';
import {baseSepolia} from 'viem/chains';
import {hashBytes,hashText,AddressSchema,ProtocolError} from '@faultline/protocol';
import {chainConfig,LiveChainGateway} from '@faultline/chain';
import {immutableJson} from '../examples/src/journal';
import {verifyDeploymentTransactions} from './deployment-evidence';
async function main() {
const required=(key:string)=>{const v=process.env[key];if(!v)throw new ProtocolError('NOT_CONFIGURED',`${key} is required`);return v;};
const base=createPublicClient({chain:baseSepolia,transport:http(required('BASE_RPC_URL'))}),gen=createClient({chain:testnetBradbury,endpoint:required('GENLAYER_RPC_URL')});
const baseAddress=AddressSchema.parse(required('BASE_ESCROW_ADDRESS')) as `0x${string}`,genAddress=AddressSchema.parse(required('GENLAYER_CONTRACT_ADDRESS')) as `0x${string}`;
const code=await base.getCode({address:baseAddress}),source=await gen.getContractCode(genAddress);
if(!code||code==='0x'||source!==await readFile('contracts/genlayer/faultline.bundle.py','utf8'))throw new Error('Deployed code missing or GenLayer source differs');
const config=chainConfig({...process.env,BASE_CODE_HASH:hashBytes(hexToBytes(code)),GENLAYER_CODE_HASH:hashText(source)});
const artifact=JSON.parse(await readFile('contracts/base/out/FaultlineBondEscrow.sol/FaultlineBondEscrow.json','utf8'));
// Compare every runtime byte except compiler-declared constructor immutable slots.
const deployed=hexToBytes(code),built=hexToBytes(`0x${artifact.deployedBytecode.object.replace(/^0x/,'')}`);
if(deployed.length!==built.length)throw new Error('Escrow runtime length mismatch');
const immutable=new Set<number>();for(const refs of Object.values(artifact.deployedBytecode.immutableReferences) as {start:number;length:number}[][])for(const r of refs)for(let i=r.start;i<r.start+r.length;i++)immutable.add(i);
for(let i=0;i<built.length;i++)if(!immutable.has(i)&&built[i]!==deployed[i])throw new Error(`Escrow runtime differs at byte ${i}`);
const gateway=await new LiveChainGateway(config).verifyDeployments();
const [baseDeployment,genDeployment]=await Promise.all(['base','genlayer'].map(async chain=>JSON.parse(await readFile(`artifacts/deployment/${chain}.json`,'utf8'))));
if(baseDeployment.status!=='finalized'||genDeployment.status!=='finalized'||baseDeployment.deployer!==genDeployment.deployer)throw new Error('Successful finalized deployment transactions are required');
const transactions=await verifyDeploymentTransactions(gateway,{deployer:baseDeployment.deployer,guardian:required('GUARDIAN_ADDRESS'),baseTransactionHash:baseDeployment.transactionHash,genlayerTransactionHash:genDeployment.transactionHash,genlayerSubmissionHash:genDeployment.submissionHash},artifact,source);
// Public origin is safe to export. RPC URLs may contain provider keys, so omit them.
await immutableJson('artifacts/deployment.json',{schemaVersion:1,base:{chainId:84532,address:baseAddress,codeHash:config.baseCodeHash,...transactions.base},genlayer:{chainId:4221,address:genAddress,codeHash:config.genlayerCodeHash,...transactions.genlayer},deployer:transactions.deployer,guardian:transactions.guardian,attestor:config.attestor,evidenceOrigin:config.evidenceOrigin});
console.log(JSON.stringify({BASE_CODE_HASH:config.baseCodeHash,GENLAYER_CODE_HASH:config.genlayerCodeHash,verified:true}));
}
void main().catch(error=>{
  // RPC errors can embed provider credentials. Publish a bounded diagnostic only.
  console.error(JSON.stringify({gate:'deployment',status:'UNMET',reason:error instanceof ProtocolError?error.code:'DEPLOYMENT_VERIFICATION_FAILED'}));
  process.exitCode=1;
});
