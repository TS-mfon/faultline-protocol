import {handleA2a} from '@faultline/a2a';
import {adapterClient,bodyJson,validOrigin} from '../../../lib/adapter';
export const runtime='nodejs';
export async function POST(request:Request){
  if(!validOrigin(request))return new Response('Origin denied',{status:403});
  try{return Response.json(await handleA2a(await bodyJson(request),adapterClient(request),request.headers.get('A2A-Version')??'0.3'),{headers:{'Cache-Control':'no-store','A2A-Version':'1.0','Vary':'A2A-Version'}});}
  catch{return Response.json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid or oversized JSON request'}},{status:400});}
}
