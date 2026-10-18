import { FaultlineClient } from '@faultline/sdk';
import { createHttpHandler,bodyJson } from './http';
import { getRuntime } from './runtime';
export {bodyJson};
export function adapterClient(request:Request):FaultlineClient {
  const baseUrl=`${process.env.PUBLIC_ORIGIN??'http://localhost:3000'}/api/v1`;
  const authorization=request.headers.get('authorization')??'';
  if(authorization&&!/^Bearer [^\s]+$/.test(authorization))throw new Error('Invalid Authorization header');
  // Dispatch in-process: no user-controlled remote URL or credential forwarding across hosts.
  const handler=createHttpHandler(getRuntime);
  return new FaultlineClient({baseUrl,token:authorization.slice(7)||undefined,fetch:async(url,init)=>handler(new Request(String(url),init))});
}
export function validOrigin(request:Request){const origin=request.headers.get('origin');return !origin||origin===(process.env.PUBLIC_ORIGIN??'http://localhost:3000');}
