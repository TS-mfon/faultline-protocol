import { it, expect, vi } from 'vitest';
import { AgentCard, CancelTaskRequest, GetTaskRequest, SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { FaultlineClient } from '@faultline/sdk';
import { hashText, type Operation } from '@faultline/protocol';
import { agentCard, handleA2a, operationTask } from '../src';

const id = hashText('task'), workflowId = hashText('workflow'), time = '2026-10-15T00:00:00Z';
const operation: Operation = { id, workflowId, kind: 'accept', status: 'awaiting_signature', createdAt: time, updatedAt: time };
const request = () => ({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {
  configuration: { returnImmediately: true },
  message: { role: 'ROLE_USER', messageId: 'stable-message', parts: [{ data: { action: 'accept', args: { workflowId } } }] },
} });
const setup = () => {
  const fetcher = vi.fn(async () => Response.json({ data: operation }));
  return { fetcher, client: new FaultlineClient({ baseUrl: 'https://faultline.test/api/v1', token: 'wallet-A', fetch: fetcher }) };
};

it('advertises v1 discovery/security and serializes caller signatures as input-required', () => {
  expect(agentCard('https://faultline.test')).toMatchObject({
    supportedInterfaces: [{ url: 'https://faultline.test/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: { walletSession: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { walletSession: {} } }],
  });
  expect(Task.toJSON(operationTask(operation))).toMatchObject({ id, contextId: workflowId, status: {
    state: 'TASK_STATE_INPUT_REQUIRED', message: { role: 'ROLE_AGENT', contextId: workflowId, taskId: id, parts: [{ data: { requiresSignature: true } }] },
  } });
  expect(operationTask({ ...operation, status: 'confirming' }).status?.state).toBe(TaskState.TASK_STATE_WORKING);
  expect(operationTask(operation).artifacts).toHaveLength(0);
});

it('preserves idempotent message identity and rejects invalid continuations before writing', async () => {
  const { fetcher, client } = setup(), body = request();
  expect(await handleA2a(body, client)).toMatchObject({ result: { task: { id, status: { state: 'TASK_STATE_INPUT_REQUIRED' } } } });
  await handleA2a(body, client);
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(calls[0]![1].headers).toEqual(calls[1]![1].headers);
  const bad = structuredClone(body) as any; bad.params.message.taskId = id;
  expect(await handleA2a(bad, client)).toMatchObject({ error: { code: -32602 } });
  bad.params.message.taskId = undefined; bad.params.message.contextId = hashText('other workflow');
  expect(await handleA2a(bad, client)).toMatchObject({ error: { code: -32602 } });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('rejects old versions, blocking sends and unsupported push without creating operations', async () => {
  const { fetcher, client } = setup(), body = request();
  expect(await handleA2a(body, client, '0.3')).toMatchObject({ error: { code: -32009 } });
  expect(await handleA2a({ ...body, method: 'message/send' }, client)).toMatchObject({ error: { code: -32601 } });
  expect(await handleA2a({ ...body, params: { ...body.params, configuration: {} } }, client)).toMatchObject({ error: { code: -32004 } });
  expect(await handleA2a({ ...body, params: { ...body.params, configuration: { returnImmediately: true, taskPushNotificationConfig: {} } } }, client)).toMatchObject({ error: { code: -32003 } });
  expect(fetcher).not.toHaveBeenCalled();
});

it('interoperates with the official v1 SDK for send, poll and uncancelable blockchain tasks', async () => {
  const { client: backend } = setup();
  const wire = vi.fn<typeof fetch>(async (input, init) => {
    const req = new Request(input, init);
    expect(req.headers.get('A2A-Version')).toBe('1.0');
    return Response.json(await handleA2a(await req.json(), backend, req.headers.get('A2A-Version')!));
  });
  const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: wire })] })
    .createFromAgentCard(AgentCard.fromJSON(agentCard('https://faultline.test')));
  const response = await client.sendMessage(SendMessageRequest.fromJSON(request().params));
  expect(response).toMatchObject({ id, status: { state: TaskState.TASK_STATE_INPUT_REQUIRED } });
  expect(await client.getTask(GetTaskRequest.fromJSON({ id, historyLength: 0 }))).toMatchObject({ id, history: [] });
  await expect(client.cancelTask(CancelTaskRequest.fromJSON({ id }))).rejects.toMatchObject({ envelopeCode: -32002 });
  expect(wire).toHaveBeenCalledTimes(3);
});
