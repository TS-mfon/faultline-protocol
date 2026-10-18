# Deployment and operations

## Environments

Use Node 24, Python 3.12 and Foundry with Solidity 0.8.30. Keep `.env*`, raw signed transaction journals and local run checkpoints out of source control. `.env.example` documents names only. All money in this version is testnet USDC on Base Sepolia (84532); the intelligent contract runs on GenLayer Bradbury (4221).

A complete live environment needs MongoDB Atlas with transactions/GridFS, a public HTTPS app, both deployed contracts, and funded participant and worker wallets. GenLayer provides responsibility and repair judgments. The example task harness is deterministic and needs no separate model-provider credential. Provisioning is not simulated by local replays.

## Order of deployment

1. Create a MongoDB replica-set database with TLS and a least-privilege application account. Configure backups and public-evidence retention. Use separate test databases for CI.
2. Push this repository to GitHub. Import it into Vercel with root directory `apps/web`; keep access to source files outside that root for npm workspaces. Use Node 24 and `npm ci` at the repository workspace root. Vercel's normal Next.js adapter serves the app and routes; this is not a static export.
3. Set `PUBLIC_ORIGIN` to the final HTTPS origin. Publish the app first; the unconfigured API must return 503. The origin is frozen into the GenLayer constructor and must be reachable by validators without Vercel authentication or WAF challenges on evidence downloads.
4. Put `DEPLOYER_PRIVATE_KEY`, `GENLAYER_RPC_URL`, `PUBLIC_ORIGIN` and `ATTESTOR_ADDRESS` in a protected, ignored environment file. Run `bash contracts/genlayer/verify.sh`, then `node --env-file=/secure/path/faultline.env --import tsx scripts/deploy-contract.ts genlayer --schema` to compare the compressed bundle's native interface with the readable source. `--estimate` measures deployment gas without signing. Deploy with the same command without an option. This uses the explicit deployer identity and preserves exact signed bytes before broadcasting. Repeat the same command to inspect or resume the same transaction. Record `GENLAYER_CONTRACT_ADDRESS` only after `artifacts/deployment/genlayer.json` reports successful native finality. The optional `GENLAYER_EVM_RPC_URL` separates ordinary chain RPC reads/submissions from native `gen_*` methods.
5. Add `BASE_RPC_URL` and `GUARDIAN_ADDRESS`, build the Base contract with Foundry, then run `node --env-file=/secure/path/faultline.env --import tsx scripts/deploy-contract.ts base`. It refuses other chains and retains the deployment nonce and signed bytes. Repeat the same command to check canonical finalized inclusion. Record the actual `BASE_ESCROW_ADDRESS` from `artifacts/deployment/base.json`. Do not run deployment commands concurrently; both use the same exclusive journal lock.
6. With both addresses and a final HTTPS origin set, run `node --env-file=/secure/path/faultline.env --import tsx scripts/capture-deployment.ts`. This compares GenLayer source, every non-immutable Base runtime byte, configured bridge identity and evidence origin. It also verifies the actual creation transactions, deployer, constructor arguments, GenLayer submission ID, successful execution and finality. Copy the resulting public code hashes into configuration. The immutable `artifacts/deployment.json` contains public deployment evidence; `artifacts/deployment/signed-transactions.private.json` must remain private.
7. Set web environment variables: MongoDB URI/database, public origin, random `AUTH_SECRET` of at least 32 bytes, both RPC URLs, contract addresses, runtime/source hashes and attestor address. Never put wallet keys in the web environment or `NEXT_PUBLIC_*` variables. Redeploy and check `/api/v1/workflows` (it checks live deployments), not just `/health`.
8. Configure GitHub's `testnet` environment and the secrets/variables listed in `.github/workflows/worker.yml`. Set repository variable `FAULTLINE_WORKER_ENABLED=true` only when both deployments and MongoDB are ready. The scheduler runs every five minutes or by workflow_dispatch; it processes at most eight jobs per invocation. One concurrency group serializes the attestor. Never use `pull_request_target` for secret-bearing jobs.

## Running live scenarios

Fund three distinct participant EOAs with at least 12 test USDC each per concurrent run, plus gas. Nine concurrent runs require 108 test USDC per participant. Fund a separate repairer with Bradbury gas; fund the worker attestor on both chains. Place caller keys in a protected environment file, separate from the web environment. Set `FAULTLINE_API_URL` and the environment names in `.env.example`. All transfers must remain on the configured testnets.

The operator can inspect balances with `node --env-file=/secure/path/faultline.env --import tsx scripts/fund-demo-wallets.ts --inspect`. After both deployments are finalized, `--fund` freezes a bounded transfer plan and saves signed bytes before broadcasting. Repeat `--fund` to reconcile the same transfers; it never replenishes spent balances automatically. Keep `artifacts/funding` private except for the public plan and receipt report.

For the nine-run release suite, configure `.github/workflows/demonstrations.yml` in GitHub's `testnet` environment. Supply the four demo caller keys separately from the worker's attestor key, shared MongoDB/RPC configuration, and public deployment identities. Set `FAULTLINE_DEMO_RUN_PREFIX=release-v1`, `FAULTLINE_API_URL` to the public `/api/v1` URL, then enable repository variable `FAULTLINE_DEMOS_ENABLED=true`. The runner freezes its nine manifests and deployments in MongoDB, holds a renewable lease, and advances them sequentially. Every checkpoint, signature and immutable evidence record survives runner replacement. Each invocation exports public status and any consensus/recovery artifacts. Do not run the file-journal CLI below for those same workflows or reset the MongoDB plan to restart them.

```bash
# From repository root; private env file is operator-managed and untracked.
node --env-file=/secure/path/faultline-demo.env --import tsx examples/src/live-cli.ts software demo-001
```

Repeat the same command/run ID to resume. Release verification requires three distinct runs in each of software, research and procurement, with all attempts retained. The keyless deterministic harness produces an upstream defect, a missed review and a downstream consequence, then computes a proposed repair. Its versioned input/output hashes are recorded. Harness instructions and expected answers are excluded from the judge's evidence; only the work artifacts and committed source are submitted. GenLayer may disagree with the illustrative allocation. These runs are live chain workflows with deterministic task generation, not live LLM agent demonstrations.

Each tick advances only on finalized receipts and returns a stage. `worker-*` awaits the scheduler, `consensus` awaits GenLayer, and `cure-window-and-reservation` preserves the full 24-hour cure. The repair period is 48 hours, hard lock seven days. These application timers do not shorten native appeal windows. Needs-evidence or unresolved results require evidence review; they are not automatically retried as a new case.

An interrupted deterministic task may safely repeat: it has no external effects and receives no credentials. Chain submissions reuse the exact signed bytes and transaction IDs in the private journal. A stale `run.lock` requires confirming the recorded process is no longer running before removing only that lock. Preserve `state.json` and `signed-transactions.private.json` together. Never publish the latter. Signing journals must survive restarts, and runs sharing participant wallets must be advanced sequentially to avoid nonce races.

Each completed or failed adjudication is preserved under `artifacts/consensus/<domain>/<runId>.json`. On completed recovery the runner rereads adjudication, reservation, repair verification, release and payout receipts and checks the USDC transfer. It writes `artifacts/live/<domain>/<runId>.json`. Existing evidence cannot be overwritten by later checkpoints. Live gates enumerate every attempt and reread chain truth instead of trusting artifact status fields:

```bash
npm run verify:consensus
npm run verify:live-demos
PUBLIC_REPOSITORY_URL=https://github.com/OWNER/REPO npm run verify:release
```

## Failure handling

Inspect operation status and the native receipt by the same transaction ID. For GenLayer, `ACCEPTED` or `FINALIZED` alone does not imply successful execution; the SDK gateway also checks execution/consensus. For Base, verify a canonical finalized receipt and decoded calldata. The signing journal contains the outer EVM hash and GenLayer logical ID when available.

Never refresh an attestation attached to a prepared intent, re-sign a failed transaction automatically, or infer failure from a temporarily missing balance. A reverted job is marked failed and retained. Investigate unknown infrastructure errors using provider-side logs and transaction IDs; the worker intentionally avoids printing signed payloads. Check outbox, lease age and pending transaction age before restarting.

Refunds need no attestor authorization. After native maturity, use the published Base ABI to call `refundExpired(workflowId)` then `withdrawFor(workflowId, immutableBeneficiary)`; withdrawals themselves can drive expiry. Guardian pause does not disable this path. If someone already withdrew, find that original finalized `Withdrawn` plus USDC `Transfer` instead of submitting again.

## CI and current test boundary

CI runs TypeScript tests, the Next production build, desktop/mobile Playwright, both contract suites and a separate MongoDB job. Run `npm run verify:mongo` locally to use the same database verification helper as CI. It starts a uniquely named `mongo:7` replica set on a random loopback port with temporary storage, waits for a writable primary, and removes the container after the check. Docker must be available; the image is downloaded if needed. Alternatively set `MONGODB_TEST_URI` to an explicitly disposable replica set. The test creates and drops a uniquely named database; it never falls back to `MONGODB_URI`.

The database check exercises concurrent idempotency, outbox uniqueness, GridFS byte integrity, persistence after closing and recreating the client, transaction rollback and stale-worker lease fencing. It does not simulate a database-server crash or an Atlas outage. The normal `npm test` command skips it without the explicit test URI, so its pass is not a substitute for `verify:mongo`.

Local sandbox restrictions may prevent browser launch, listeners, cache access, MongoDB or external network calls. Those checks remain unmet until executed in an environment that supports them. Direct and authored replay tests must never be cited as live consensus or payment evidence. See [release status](STATUS.md) for the measured verification boundary and remaining live requirements.
