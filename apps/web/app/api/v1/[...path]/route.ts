import { createHttpHandler } from '../../../../lib/http';
import { getRuntime } from '../../../../lib/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createHttpHandler(getRuntime);
export const POST = GET;
