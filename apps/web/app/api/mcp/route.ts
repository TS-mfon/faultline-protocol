import {handleMcp} from '@faultline/mcp';
import {adapterClient,bodyJson,validOrigin} from '../../../lib/adapter';
export const runtime='nodejs';
export async function POST(request:Request){
  if(!validOrigin(request))return new Response('Origin denied',{status:403});
  try{const body=await bodyJson(request);const safe=new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body)});return await handleMcp(safe,adapterClient(request));}
  catch{return Response.json({error:{code:'INVALID_REQUEST',message:'Invalid MCP request'}},{status:400});}
}
export function GET(){return new Response('Stateless JSON transport; use POST',{status:405,headers:{Allow:'POST'}});}
export const DELETE=GET;
