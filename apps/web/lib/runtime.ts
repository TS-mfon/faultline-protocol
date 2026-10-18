import { FaultlineService, MongoStore, WalletAuth } from '@faultline/service';
import { LiveChainGateway, chainConfig } from '@faultline/chain';
import type { HttpRuntime } from './http';
let runtimePromise: Promise<HttpRuntime | null> | undefined;
export function getRuntime(): Promise<HttpRuntime | null> {
  if(!process.env.MONGODB_URI) return Promise.resolve(null);
  return runtimePromise ??= initialize().catch(error=>{runtimePromise=undefined;throw error;});
}
async function initialize():Promise<HttpRuntime> {
  const origin=process.env.PUBLIC_ORIGIN;
  if(!origin || !process.env.AUTH_SECRET) throw new Error('PUBLIC_ORIGIN and AUTH_SECRET are required');
  const gateway=await new LiveChainGateway(chainConfig()).verifyDeployments();
  const store=await MongoStore.connect(process.env.MONGODB_URI!,process.env.MONGODB_DATABASE??'faultline');
  const service=new FaultlineService(store,gateway,{evidenceOrigin:`${origin}/api/v1/evidence`,workerActors:{base:process.env.ATTESTOR_ADDRESS,genlayer:process.env.ATTESTOR_ADDRESS}});
  const auth=new WalletAuth(store,{secret:process.env.AUTH_SECRET,origin,audience:'faultline-api-v1'});
  return {service,store,auth};
}
