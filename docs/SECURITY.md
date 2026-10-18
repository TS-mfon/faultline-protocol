# Trust and failure boundaries

Faultline v1 is a testnet prototype for agreed contractual responsibility. It does not prove objective causation and has not received an independent external security audit. Liability can arise only under frozen duties. Detection failures require an explicit detection duty; downstream consequence is not automatically fault. Material unresolved findings block monetary reservation.

## Consensus and evidence

GenLayer stores immutable manifests and journals, fetches exact hashed public evidence and validates structured judgments. Validators independently derive substantive findings, causal edges, duties and remedy selection; malformed leader output or substantive disagreement cannot silently become agreement. A separately successful finalized repair judgment is required before release. Direct tests mock model/web calls and exercise captured validator comparison logic; only actual Bradbury transactions demonstrate network consensus.

Evidence is public and can contain hostile instructions. It is quoted as data, bounded in size, escaped in the UI and never executed by the application. Hashing proves byte identity, not truth. An operator controlling MongoDB can censor evidence; hash commitments prevent replacing it unnoticed. Version one is unsuitable for confidential logs, personal data or secrets. Availability failures should leave judgment pending/failed or request evidence, never establish innocence.

## Bridge

A single disclosed EOA attests to finalized GenLayer outcomes for Base. This is an explicit trust assumption. A compromised attestor can lie about off-chain verification within the contract's fixed bounds; this is not a trustless cross-chain proof. The Base contract independently enforces signatures, source chain/contract, workflow/terms/case/snapshot identities, phase, nonce, expiry, participants, weights, repair price and immutable recipient. No proxy or arbitrary beneficiary change exists.

The service verifies both chain IDs, source/runtime hashes, USDC identity, attestor identity on both chains and the public evidence origin. The worker rereads native receipts before creating EIP-712 authorizations. Repair acceptance is distinct from initial responsibility. Reservations only lock accounting. Releases create credits. Completed application recovery requires a finalized `withdrawFor` receipt and matching USDC `Transfer` event.

The GenLayer deployment uses a compressed, immutable Python bundle to fit the chain's transaction gas limit. Its build checks reversible AST transformations and exact decompression against the linted source; contract tests execute through that bundle. The loader executes only its built-in payload, with no downloaded code or evidence input. Deployment capture binds its exact bytes and constructor arguments to the actual EVM submission and successful finalized native transaction.

## Keys and retries

Caller wallets accept mandates, fund bonds and publish signed handoffs. API bearer sessions cannot sign. The worker attestor key belongs only in the worker's protected environment; deployer and guardian keys remain separate. Deterministic task subprocesses receive only the executable search path, with no wallet, database, attestor or provider credentials. GenLayer independently judges their submitted artifacts. Never run generated source code as part of these examples.

The worker saves exact signed transaction bytes before broadcasting, with uniqueness on operation ID and `(chain, sender, nonce)`. After an interruption it resends only those bytes. Lease fencing and a heartbeat prevent stale workers from committing results. An expired signed transaction is not silently replaced with a new authorization. Failed operations retain their audit record and require an operator to inspect native chain truth. Public audits exclude raw signing journals and bearer tokens.

## Recovery and limitations

Guardian pause blocks new escrow activity but does not block matured refunds. Failed repair restores exact recorded debits at maturity. A worker sweeps matured refunds and fixed-beneficiary withdrawals; participants can call the contract directly if the service fails. The worker reconciles permissionless third-party withdrawals against the original finalized `Withdrawn` and matching USDC `Transfer`, and retires unsigned duplicate payout jobs. An already signed duplicate can still revert safely; it never redirects funds.

The service currently lists workflows for scheduled cleanup rather than partitioning a large index. GitHub cron is best-effort, not a deadline guarantee. Run one worker per attestor and alert on failures/expirations. MongoDB transactions require a replica set. Faultline charges no protocol fee; network gas still applies. Operation outbox records provide metering/audit events, but no billing collector or enterprise invoicing is implemented.

The original 3:1 weighting is a contractual policy, not a measure of scientific causal contribution. Reputation remains contextual to a domain. Future versions need prior-art research, privacy controls, stronger bridge trust, independent audits and operational load tests before production use.
