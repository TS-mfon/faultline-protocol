import {agentCard} from '@faultline/a2a';
export function GET(){const origin=process.env.PUBLIC_ORIGIN;if(!origin)return Response.json({error:'Public service origin is not configured'},{status:503});return Response.json(agentCard(origin));}
