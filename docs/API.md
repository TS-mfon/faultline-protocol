# Faultline v1 API

Base path: `/api/v1`. Success envelopes are `{data:...}` and failures are `{error:{code,message}}`. Workflow/operation IDs are lowercase SHA256 values prefixed with `0x`. Amounts are decimal strings of integer USDC micro-units. Requests are limited to 64 KiB. Mutations need `Content-Type: application/json` and a stable `Idempotency-Key` (1–128 letters, digits, `_`, `-`, `:`, `.`). Changed content under the same key is rejected.

All records and evidence are public in v1. Writes derive the actor from a verified bearer session; passing `actor` or `mode` in the body cannot impersonate a wallet or enable replay on the live API. API credentials grant no signing authority.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/health` | Configuration status; not a claim of successful deployment verification |
| POST | `/auth/challenge` | `{address}` → exact message, challenge ID and expiry |
| POST | `/auth/verify` | `{id,signature}` → short-lived wallet-bound bearer token |
| POST | `/artifacts` | `{text,hash?}` → immutable content hash, accessible at `/evidence/{hash}` |
| GET | `/workflows` | Public workflow records |
| POST | `/workflows` | `{manifest}` → caller-signable registration operation |
| GET | `/workflows/{id}` | Status, commitments, handoffs and decision |
| POST | `/workflows/{id}/accept` | `{}` → GenLayer acceptance intent |
| POST | `/workflows/{id}/fund` | `{}` → Base escrow bond deposit intent; approve USDC separately |
| POST | `/workflows/{id}/handoffs` | `HandoffManifest` |
| POST | `/workflows/{id}/acknowledgments` | `{handoffId}` |
| POST | `/workflows/{id}/failures` | `{nodeId,impact}` |
| POST | `/workflows/{id}/evidence` | `EvidenceItem` with complete text |
| POST | `/workflows/{id}/close-evidence` | `{}` |
| POST | `/workflows/{id}/adjudicate` | `{}` → worker operation |
| POST | `/workflows/{id}/repairs` | `RepairSubmission` |
| GET | `/operations/{id}` | Queued, awaiting_signature, submitted, confirming, completed or failed |
| POST | `/operations/{id}/confirm` | `{txHash}` → independently checked receipt/status |
| GET | `/workflows/{id}/audit` | Manifest, snapshots, public operation intents and receipt journal |
| GET | `/agents/{address}/reputation` | Domain-specific finalized GenLayer reputation |
| GET | `/evidence/{hash}` | Exact committed bytes, immutable cache headers, download-only content |

Canonical schemas are exported by `packages/protocol/src/index.ts`. GenLayer and Base ABIs are published beside their contracts. Do not reconstruct calldata from this table.

## SDK

```ts
import {FaultlineClient, bondApproval} from '@faultline/sdk';
const client = new FaultlineClient({baseUrl: 'https://YOUR_HOST/api/v1'});
await client.authenticate(account.address, message => account.signMessage({message}));
const operation = await client.accept(workflowId, {idempotencyKey: 'accept-run-0001'});
// Caller supplies a signer for the exact intent; check chain, contract, method and amounts.
await client.submitOperation(operation, yourIntentSigner);
```

`bondApproval(escrow, amount)` returns an exact USDC approval intent separate from the deposit. `submitOperation` does not re-sign an operation with an existing hash. Production callers should use a durable signing journal to cover the interval between broadcast and API confirmation; the example runner provides one. GenLayer logical transaction IDs and outer EVM submission hashes differ.

## MCP

HTTP uses stateless Streamable HTTP at `/api/mcp`, JSON responses and the official MCP SDK. Tests negotiate protocol `2025-11-25`. Send `Accept: application/json, text/event-stream` and supply a wallet-session `Authorization: Bearer ...` for mutations. Every request creates a separate client/transport so bearer identity cannot bleed across requests. Streaming, subscriptions and OAuth discovery are not advertised.

For stdio, set `FAULTLINE_API_URL` and optional `FAULTLINE_TOKEN`, then run `npm start --workspace @faultline/mcp`. Tools are `faultline_list_workflows`, `faultline_get_workflow`, `faultline_get_operation`, `faultline_audit`, `faultline_reputation`, and `faultline_action`. The action tool accepts `{action,args,idempotencyKey}`. Supported actions: create, accept, fund, handoff, acknowledge, report, evidence, close_evidence, adjudicate, repair, confirm. Full public artifact uploads use REST/SDK.

## A2A

Faultline supports the asynchronous **A2A v1.0 JSON-RPC subset**. Discovery is at `/.well-known/agent-card.json`; send `A2A-Version: 1.0` to `/api/a2a`. The official JavaScript A2A v1 client is exercised in the interoperability tests. Supported methods are `SendMessage`, `GetTask` and `CancelTask`; cancellation returns `TaskNotCancelable` because submitted blockchain transactions cannot be undone. Streaming and A2A push notifications are not advertised.

```json
{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"configuration":{"returnImmediately":true},"message":{"role":"ROLE_USER","messageId":"stable-run-message-1","parts":[{"data":{"action":"accept","args":{"workflowId":"0x...64 lowercase hex characters..."}}}]}}}
```

Set `configuration.returnImmediately=true`: operations must survive native finality waits beyond a request's lifetime. Blocking sends are rejected before dispatch. A send returns `{task: ...}`; `GetTask` takes `{id: operationId}` and returns the task directly. Task IDs are durable operation IDs; context IDs are workflow IDs. Caller signatures map to `TASK_STATE_INPUT_REQUIRED`, pending finality to `TASK_STATE_WORKING`. A completed task describes that operation; a completed workflow and verified withdrawal establish payment. Confirm with action `confirm` and `{operationId,txHash}` in a new message. A supplied `taskId` must match that operation, and a supplied `contextId` must match its workflow.

`GET /operations/:id/finality` and `client.getOperationFinality(id)` expose the native GenLayer status, appeal eligibility and finalization eligibility at an observed block. Eligibility never substitutes for successful finalized execution. Replay and unsigned operations report `supported:false`.

## Outbox webhooks

The operator may configure one HTTPS receiver with worker-only `FAULTLINE_WEBHOOK_URL` and `FAULTLINE_WEBHOOK_SECRET` (at least 32 random bytes). The worker delivers at most 20 pending events per tick and marks each delivered only after a 2xx response. Failed requests stay in the durable outbox for a later tick; redirects are refused. Without an endpoint the outbox remains available in MongoDB. This is separate from A2A push notifications.

Verify the exact request text using `verifyWebhook(rawBody, request.headers.get('Faultline-Signature'), secret)` from `@faultline/sdk/webhooks` before parsing or acting. The signature is HMAC-SHA256 over `timestamp.rawBody`, with a five-minute clock tolerance. Persist event IDs and ignore duplicates: delivery is at least once, and a crash after receiver acceptance can deliver the same ID again. Events contain the sanitized public operation view; pending worker authorizations and signed transactions are excluded.
