import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FaultlineClient } from '@faultline/sdk';
import { createMcpServer } from './index';
const baseUrl=process.env.FAULTLINE_API_URL;
if(!baseUrl)throw new Error('FAULTLINE_API_URL is required');
const server=createMcpServer(new FaultlineClient({baseUrl,token:process.env.FAULTLINE_TOKEN}));
await server.connect(new StdioServerTransport());
