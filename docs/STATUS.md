# Release status

Updated 2026-10-18. Faultline is a testnet prototype. Local release checks pass; the nine required live recoveries have not yet completed.

## Public endpoints and deployments

- Application: https://faultline-protocol-theta.vercel.app
- Source: https://github.com/TS-mfon/faultline-protocol
- Base Sepolia escrow: `0x0591a86dadd8ed8edcbba3dfdab8240019006730`. Creation transaction `0x3dbee249a8cfaf751493674c0f9d36ac1f735924c526019ab24a4bb3ffa24e6c` executed successfully and is finalized.
- GenLayer Bradbury contract: `0x0f7688ab324f8b367ed4d3d0f1bf233f30fed58a`. Native deployment `0xdac4fac139455f4f7097285abaaddd00532279aea2ede391b4fde032399f892d` executed with `FINISHED_WITH_RETURN` and `AGREE`. As observed at 03:36 UTC, its status was `ACCEPTED`; native eligibility begins no earlier than 04:00:22 UTC. That time alone does not establish finality.

The accepted GenLayer submission is `0x85b0b24e8c32863012910cb0aee3a6a320dd71c422c700f5b3f81fb2d076359d`. The 15,259-byte compressed bundle has SHA256 `0x5f50126a895715ed48b33f1d90f3760b8f3d35dffc936ecbe0ad1bbfbef34dec`. It contains the mechanically verified contract, with unchanged storage, public interface and literal values. Native schema generation matched the readable source. The rejected oversized envelopes remain archived privately and were replaced only after checking their precise RPC rejection, absence and unchanged nonce.

The public application is being updated from its replay preview to this release. A reachable page alone does not establish a configured live API. Deployment capture and live gates must pass before recording that transition as complete.

## Verified behavior

Completed recovery requires a distinct successful finalized adjudication, accepted repair judgment, release and actual USDC withdrawal. A release credit does not mark recovery complete. Permissionless withdrawals are reconciled from their original finalized receipt. Matured refunds and remaining beneficiary credits remain recoverable after terminal application outcomes.

The worker and demonstration runner preserve signatures before broadcasting. MongoDB checkpoints, leases, immutable evidence and caller journals survive runner replacement. The scheduled suite freezes exactly nine runs: three each in software, research and procurement. Tasks use a labeled deterministic, keyless harness. GenLayer alone judges responsibility and repair acceptance; no separate model-provider credential is required.

The shared-wallet funding runner keeps each exact 12-USDC approval with its run and requires canonical Base finality before another run can use that wallet's allowance. Its regressions cover interleaved runs, interrupted approvals, saved unsigned deposits, reverted transactions and noncanonical receipts. The MongoDB reconnect check verifies the latest signed record independently for each chain and caller.

Worker startup failures use a bounded logger, including configuration and database initialization errors. Public operation responses and artifacts exclude private keys, bearer tokens and signed transaction payloads.

## Measured local verification

| Check | Result | Evidence boundary |
| --- | --- | --- |
| TypeScript types and regressions | Passed | Protocol, application, integrations, worker, demonstrations and release controls; chain responses are mocked |
| Production build | Passed | Next.js 16.3.8 application and API routes |
| Browser lifecycle | 18 passed | Desktop/mobile fixtures cover caller signatures, pending finality, evidence, repair, payout and refunds |
| MongoDB | Both integration suites passed | Disposable real replica set; persistence, transactions, concurrent idempotency, exact evidence bytes and stale-lease rejection |
| Base escrow | 57 passed, including three fuzz properties at 512 runs each | Local Foundry execution; 13,869-byte runtime and published ABI/schema verification |
| GenLayer | Lint and SDK validation; 35 offline and seven direct checks passed | Tests load the compressed bundle, use actual SDK storage with mocked web/model responses, and exercise validator callbacks |
| Dependency audit | No published npm advisories | Resolved package-lock.json; this is not a security audit of the project |

Command-bound continuation evidence is recorded in the private `.unlazy/faultline` ledger. Live checks reject missing deployment or receipt evidence; fixtures never satisfy them. GitHub CI independently repeats the local checks on the published commit.

## Remaining live evidence

`root:G4` and `node-continuation:N8` require three distinct successful finalized adjudications per domain. `root:G9` and `node-continuation:N9` require completed recovery artifacts with the separate repair judgment and matching USDC withdrawal. `root:G10` and `node-continuation:N10` additionally verify the public app/API/source and deployed identities.

Preserve native finality, the full 24-hour cure, 48-hour repair and seven-day hard lock. The protected GitHub workers advance durable jobs through those windows. Publication, funding, an accepted transaction or elapsed time cannot substitute for successful finalized receipts.

Continue using [the runbook](RUNBOOK.md) and [trust model](SECURITY.md). The single attestor and public evidence store remain explicit trust assumptions. No independent external audit, production readiness, scientific causality or unsupported novelty is claimed.
