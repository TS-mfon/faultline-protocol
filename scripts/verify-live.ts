import {readFile} from 'node:fs/promises';
import {LiveChainGateway,chainConfig} from '@faultline/chain';
import {domains} from '../examples/src/scenarios';
import {readEvidence,ReleaseEvidenceError,requireDemonstrationCoverage,verifyConsensusSet,verifyDemonstration,verifyDeploymentRecord,verifyPublicRelease} from './release-evidence';
import {verifyDeploymentTransactions} from './deployment-evidence';
import {canonical} from '@faultline/protocol';
const kind=process.argv[2];
try {
 const config=chainConfig(),gateway=await new LiveChainGateway(config).verifyDeployments();
 const deployment=JSON.parse(await readFile('artifacts/deployment.json','utf8'));
 verifyDeploymentRecord(deployment,config);
 const observed=await verifyDeploymentTransactions(gateway,{deployer:deployment.deployer,guardian:deployment.guardian,baseTransactionHash:deployment.base.transactionHash,genlayerTransactionHash:deployment.genlayer.transactionHash,genlayerSubmissionHash:deployment.genlayer.submissionHash},JSON.parse(await readFile('contracts/base/out/FaultlineBondEscrow.sol/FaultlineBondEscrow.json','utf8')),await readFile('contracts/genlayer/faultline.bundle.py','utf8'));
 for(const chain of ['base','genlayer'] as const)for(const [key,value] of Object.entries(observed[chain]))if(canonical(deployment[chain][key])!==canonical(value))throw new ReleaseEvidenceError('DEPLOYMENT_RECEIPTS_CHANGED');
 if(!['consensus','demos','release'].includes(kind))throw new ReleaseEvidenceError('UNKNOWN_GATE');
 let consensusWorkflows:string[]=[];
 if(kind==='consensus'||kind==='release'){
  const attempts=await verifyConsensusSet(await readEvidence('artifacts/consensus'),gateway);
  consensusWorkflows=attempts.map(attempt=>attempt.workflowId);
  console.log(JSON.stringify({kind:'consensus',attempts}));
 }
 const completed:string[]=[];
 if(kind==='demos'||kind==='release'){
  const artifacts=await readEvidence('artifacts/live');
  requireDemonstrationCoverage(artifacts);
  for(const domain of domains){
   const runs=artifacts.filter(artifact=>artifact.domain===domain);
   if(!runs.length)throw new ReleaseEvidenceError('LIVE_DEMONSTRATION_MISSING');
   for(const artifact of runs){const verified=await verifyDemonstration(artifact,domain,gateway);completed.push(verified.workflowId);console.log(JSON.stringify({domain,workflowId:verified.workflowId,verified:true}));}
  }
 }
 if(kind==='release'){
  if(canonical([...consensusWorkflows].sort())!==canonical([...completed].sort()))throw new ReleaseEvidenceError('RECOVERY_ATTEMPTS_MISSING');
  await verifyPublicRelease(process.env.PUBLIC_ORIGIN??'',process.env.PUBLIC_REPOSITORY_URL??'',completed);
  for(const path of ['README.md','docs/PROTOCOL.md','docs/RUNBOOK.md','docs/SECURITY.md','docs/STATUS.md','docs/PRIOR_ART.md'])if(!(await readFile(path,'utf8')).trim())throw new ReleaseEvidenceError('RELEASE_DOCUMENT_MISSING');
 }
 console.log(`LIVE:${kind}:PASS`);
} catch(error) {console.error(JSON.stringify({gate:kind,status:'UNMET',reason:error instanceof Error?error.name:'UnknownError',...(error instanceof ReleaseEvidenceError?{code:error.code}:{}),detail:'Requires configured deployments, three independent adjudications per domain, actual native/payment receipts and public app/source. No fixture fallback.'}));process.exitCode=1;}
