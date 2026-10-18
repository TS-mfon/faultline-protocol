# Faultline Protocol

Faultline records agent commitments, traces failed dependencies and coordinates bounded recovery. GenLayer interprets whether agreed duties were breached; Base Sepolia holds USDC bonds and enforces deterministic settlement. The frontend exposes the graph, evidence, reasons, operations and repair status.

Open the [investigation application](https://faultline-protocol-theta.vercel.app) or browse the [source](https://github.com/TS-mfon/faultline-protocol). This is a testnet prototype. The included read-only scenarios are labeled replays; the live release suite uses deterministic tasks with GenLayer judgments. See [release status](docs/STATUS.md) for deployment and recovery evidence. A local test pass does not establish live consensus or payment.

## Run the application

Node 24 and npm 11 are required.

```bash
npm ci
npm run dev
```

Open the URL printed by Next.js. Without live configuration, the investigation UI offers three read-only replays and the API reports `503 NOT_CONFIGURED`. No database or wallet is needed to inspect them.

```bash
npm run replay --workspace @faultline/examples -- software
npm run replay --workspace @faultline/examples -- research
npm run replay --workspace @faultline/examples -- procurement
```

Each example has three mandate owners with 12 USDC bonds, an upstream defect, a missed detection duty and a downstream consequence. Its authored allocation is 9/3/0 USDC from a 12 USDC repair budget. The examples share their source data with the web templates.

## Verify

```bash
npm run typecheck
npm test
npm run verify:mongo
npm run build
bash contracts/base/verify.sh
bash contracts/genlayer/verify.sh
npx playwright install chromium
npx playwright test
```

Foundry uses Solidity 0.8.30. GenLayer checks use Python 3.12, `genlayer-test==0.29.2` and `genvm-linter==0.11.0`; install `contracts/genlayer/requirements-dev.txt` and run `genvm-lint download --version v0.3.0-rc7`. The contract pins a concrete GenVM runner. Direct tests use real SDK storage with mocked web/model calls, not network consensus.

`verify:mongo` starts and removes a disposable Docker replica set, or uses an explicitly supplied `MONGODB_TEST_URI`. It never uses the application database. `npm test` skips the two database suites when the test URI is absent; run the dedicated command to verify persistence and transaction behavior.

## Layout

| Path | Responsibility |
| --- | --- |
| `packages/protocol` | Schemas, canonical hashing, DAG validation and integer allocation |
| `contracts/genlayer` | Commitments, evidence, independent validator comparisons, repair judgments and contextual reputation |
| `contracts/base` | EIP-712 authorizations, capped bonds, reservation, fixed-recipient credits and withdrawals |
| `packages/service` | Wallet sessions, MongoDB/GridFS, transactional operations, leases and audit journal |
| `packages/chain` | Testnet-only RPC adapters, deployment checks and native finality verification |
| `apps/worker` | Durable signed transaction journal, attestation, recovery, refunds and payouts |
| `apps/web` | Investigation UI, REST, MCP and A2A routes |
| `packages/sdk`, `packages/mcp`, `packages/a2a` | Caller-controlled integrations |
| `examples` | Authored replays and resumable deterministic tasks with live GenLayer judgments |
| `skills/faultline` | Agent workflow instructions |

Start with [protocol rules](docs/PROTOCOL.md), [API usage](docs/API.md), [deployment and operations](docs/RUNBOOK.md), [trust model](docs/SECURITY.md), and the [prior-art comparison](docs/PRIOR_ART.md). The project makes no novelty claim; empirical comparison and broader prior-art research remain open.
