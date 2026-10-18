import { AgentCard, Task } from '@a2a-js/sdk';
import { A2A_ERROR_CODE as codes } from '@a2a-js/sdk/errors';
import { FaultlineClient, FaultlineApiError, actions, dispatch, type Action } from '@faultline/sdk';
import { hashText, type Operation } from '@faultline/protocol';

export const PROTOCOL_VERSION = '1.0';
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const taskId = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const historyLength = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);

export function agentCard(origin: string) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('HTTPS is required');
  return AgentCard.toJSON(AgentCard.fromJSON({
    name: 'Faultline Protocol',
    description: 'Contractual responsibility and bounded recovery for agent workflows. Public evidence. Testnets only. Caller signatures required.',
    supportedInterfaces: [{ url: url.origin + '/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: PROTOCOL_VERSION }],
    version: '0.1.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    securitySchemes: { walletSession: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'Faultline wallet session' } } },
    securityRequirements: [{ schemes: { walletSession: { list: [] } } }],
    skills: [{
      id: 'workflow-recovery', name: 'Workflow responsibility and repair',
      description: 'Send one data part with action and args, a stable messageId, and configuration.returnImmediately=true. Poll GetTask by operation ID. Sign input-required intents with your own wallet. Blockchain operations cannot be canceled.',
      tags: ['responsibility', 'recovery', 'genlayer'],
      examples: ['Register immutable mandates', 'Report a failed dependency', 'Verify repair before releasing USDC'],
    }],
  }));
}

/** SDK model; use Task.toJSON at the wire boundary for the v1 enum/part encoding. */
export function operationTask(op: Operation): Task {
  const state = ({ queued: 'TASK_STATE_SUBMITTED', awaiting_signature: 'TASK_STATE_INPUT_REQUIRED', submitted: 'TASK_STATE_WORKING', confirming: 'TASK_STATE_WORKING', completed: 'TASK_STATE_COMPLETED', failed: 'TASK_STATE_FAILED' } as const)[op.status];
  const contextId = op.workflowId ?? op.id;
  return Task.fromJSON({
    id: op.id, contextId,
    status: { state, timestamp: op.updatedAt, message: {
      messageId: hashText(op.id + ':' + op.updatedAt + ':' + op.status), role: 'ROLE_AGENT', contextId, taskId: op.id,
      parts: [{ data: { operation: op, requiresSignature: op.status === 'awaiting_signature' }, mediaType: 'application/json' }],
    } },
    ...(op.status === 'completed' ? { artifacts: [{ artifactId: op.id, name: 'Operation result', parts: [{ data: { operation: op }, mediaType: 'application/json' }] }] } : {}),
  });
}

export async function handleA2a(body: unknown, client: FaultlineClient, version = PROTOCOL_VERSION): Promise<Record<string, unknown>> {
  const b = record(body) ? body : {};
  const id = typeof b.id === 'string' || (typeof b.id === 'number' && Number.isFinite(b.id)) ? b.id : null;
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (b.jsonrpc !== '2.0' || id === null || typeof b.method !== 'string') return error(codes.INVALID_REQUEST, 'Invalid JSON-RPC request');
  if (version !== PROTOCOL_VERSION) return error(codes.VERSION_NOT_SUPPORTED, 'Send A2A-Version: 1.0');
  if (!record(b.params)) return error(codes.INVALID_PARAMS, 'An object of method parameters is required');
  if (b.params.tenant) return error(codes.UNSUPPORTED_OPERATION, 'Tenant routing is not supported');
  try {
    if (b.method === 'GetTask' || b.method === 'CancelTask') {
      if (!taskId(b.params.id) || !historyLength(b.params.historyLength)) return error(codes.INVALID_PARAMS, 'Supply a valid operation ID and nonnegative historyLength');
      const op = await client.getOperation(b.params.id);
      if (b.method === 'CancelTask') return error(codes.TASK_NOT_CANCELABLE, 'Blockchain operations cannot be canceled; contractual expiry and refunds remain available');
      return { jsonrpc: '2.0', id, result: Task.toJSON(operationTask(op)) };
    }
    if (b.method !== 'SendMessage') return error(codes.METHOD_NOT_FOUND, 'Supported methods: SendMessage, GetTask, CancelTask (A2A 1.0)');
    const configuration = b.params.configuration;
    if (!record(configuration) || configuration.returnImmediately !== true) return error(codes.UNSUPPORTED_OPERATION, 'Set configuration.returnImmediately=true; native finality is asynchronous');
    if (configuration.taskPushNotificationConfig) return error(codes.PUSH_NOTIFICATION_NOT_SUPPORTED, 'Poll GetTask for updates');
    if (!historyLength(configuration.historyLength)) return error(codes.INVALID_PARAMS, 'historyLength must be nonnegative');
    if (configuration.acceptedOutputModes !== undefined && (!Array.isArray(configuration.acceptedOutputModes) || !configuration.acceptedOutputModes.includes('application/json'))) return error(codes.CONTENT_TYPE_NOT_SUPPORTED, 'Responses require application/json');
    const message = b.params.message;
    if (!record(message) || 'kind' in message || message.role !== 'ROLE_USER' || typeof message.messageId !== 'string' || !message.messageId || message.messageId.length > 128 || !Array.isArray(message.parts) || message.parts.length !== 1) return error(codes.INVALID_PARAMS, 'Supply one ROLE_USER data part and a stable messageId');
    const part = message.parts[0];
    if (!record(part) || ['kind', 'text', 'raw', 'url'].some(key => key in part) || !record(part.data)) return error(codes.INVALID_PARAMS, 'Supply one v1 structured data part');
    const data = part.data;
    if (!actions.includes(data.action) || !record(data.args)) return error(codes.INVALID_PARAMS, 'Data requires action and args');
    if (message.taskId && (data.action !== 'confirm' || message.taskId !== data.args.operationId)) return error(codes.INVALID_PARAMS, 'Continuation must confirm the same operation');
    let contextId = data.args.workflowId ?? data.args.manifest?.id;
    if (data.action === 'confirm' && message.contextId) contextId = (await client.getOperation(data.args.operationId)).workflowId ?? data.args.operationId;
    if (message.contextId && message.contextId !== contextId) return error(codes.INVALID_PARAMS, 'contextId must match the operation workflow');
    const op = await dispatch(client, data.action as Action, data.args, 'a2a-' + hashText(message.messageId).slice(2));
    return { jsonrpc: '2.0', id, result: { task: Task.toJSON(operationTask(op)) } };
  } catch (e) {
    if (e instanceof FaultlineApiError) return error(e.status === 404 ? codes.TASK_NOT_FOUND : -32000, e.code + ': ' + e.message);
    return error(codes.INVALID_PARAMS, 'Invalid Faultline action parameters');
  }
}
