# Faultline GenLayer interface v1

Readable source: `contracts/genlayer/faultline.py`, contract `Faultline`. Deploy
`contracts/genlayer/faultline.bundle.py`, generated with Python 3.12 by `build.py`.
The build removes whitespace and reversibly renames bound local identifiers; it
checks AST equivalence while preserving persistent fields, public methods and
arguments, imports and literal values. The intermediate `faultline.deploy.py` is
linted alongside the readable source. The bundle decompresses and executes only
that immutable payload; it never downloads code or executes evidence. Every local
contract test loads the bundle. Before deployment, `deploy-contract.ts genlayer
--schema` also compares its native GenVM schema with the original source.
Deployment hashes refer to the exact bundle bytes. Single-file deployment,
pinned runner `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`.

Constructor: `(evidence_origin: str, funding_attestor: str)`. Evidence origin is an
HTTPS base URL without a trailing slash, e.g. `https://evidence.example/api/immutable`.
The attestor is an explicitly trusted, immutable, lowercase EOA address. All actor
writes require the native sender to equal the transaction origin. No application
signature, actor field, or authorization header substitutes for the native caller.

## Views for the live gateway

`get_workflow(workflow_id: str) -> str` and `get_case(workflow_id: str) -> str` both
return **canonical JSON strings**. Decode exactly once after native calldata decoding.
All timestamps are integer Unix seconds. No view asserts native finality.

Both views always expose:

| Key | JSON type | Meaning |
| --- | --- | --- |
| workflowId | string | Manifest ID |
| workflowHash, hash | string | Same SHA256 of accepted canonical manifest |
| caseId | string or null | SHA256 of `{workflowId,workflowHash,report}` |
| status | string | Application lifecycle state |
| snapshotHash | string or null | Latest successfully adjudicated raw canonical snapshot SHA256 |
| decision | object or null | Exact `DecisionSchema` result, including NEEDS_EVIDENCE |
| decisionHash, decisionId | string or null | Same SHA256 of canonical decision |
| repairHash | string or null | Submitted canonical repair SHA256 |
| repairAccepted | boolean or null | Null before separate successful verification; verdict boolean afterward |
| repairVerdict | object or null | Separate repair judgment |
| repairVerdictId | string or null | SHA256 of canonical repair verdict |

`get_workflow` also exposes `manifest`, `createdAt`, `expiresAt`, `activatedAt`
(0 before activation), `accepted` (sorted address array), `bonded` (address to decimal
USDC micro-units), `fundingReceipt`, `handoffs`, `acknowledgments`, `suspendedNodes`.
Native acknowledgment records contain `{handoffId,agent}` only. A method cannot know
its own transaction hash: snapshot `txHash` references must be supplied and verified
by the attestor. No synthetic transaction hash is returned by the view.

When a case exists, `get_case` also exposes `report`, `openedAt`, `evidenceRound`,
`responseDeadline`, `evidenceClosed`, `closeVotes`, `evidence`, `snapshotUrl`,
`snapshot`, `history` (round, snapshotHash, snapshotUrl, decisionId, decision),
`allocations` (`{agent,weight,amount}`), `cureDeadline`, `repairDeadline`, `repairUrl`,
`repair`. A pending second round retains the first successful decision and snapshot
for audit; `status=needs_evidence` and empty allocations prohibit settlement.

`get_reputation(agent: str, domain: str) -> dict` returns `agent`, `domain`, and integer
counters `cases`, `primary`, `contributory`, `downstream_consequence`, `excused`,
`unresolved`, `repairsAccepted`, `repairsRejected`. Cases count once per participant;
class counters count findings per mandate. No reputational credit follows an unreported
run or timeout. Native rollback also rolls back counters.

The gateway must check successful execution, native FINALIZED, contract and chain,
exact decoded method/arguments/from, plus these bound state values from the latest
finalized view. Application deadlines never establish or shorten native appeal windows.
`status=completed` alone does not mean a repair was accepted and cannot authorize release.

## Writes

All named JSON inputs use the strict protocol schemas in `packages/protocol/src/index.ts`
and normalized lowercase addresses. Unknown keys, duplicate JSON keys, floats, unsafe
integers, malformed UTF-8/surrogates and noncanonical amount strings are rejected.

| Method | Native caller | Result |
| --- | --- | --- |
| register_workflow(manifest_json: str) | manifest creator | workflow ID string |
| accept_mandate(workflow_id: str) | participant | null; accepts all their nodes |
| activate_workflow(workflow_id: str, funding_receipt_json: str) | attestor | null |
| record_handoff(handoff_json: str) | mandate producer | null |
| acknowledge_handoff(workflow_id: str, handoff_id: str) | direct consumer | null |
| open_case(workflow_id: str, report_json: str) | participant reporter | case ID string |
| submit_evidence(workflow_id: str, evidence_json: str) | participant submitter | null |
| close_evidence(workflow_id: str) | participants early; anyone at deadline | null |
| adjudicate(workflow_id: str, snapshot_url: str, snapshot_hash: str) | attestor | null |
| submit_repair(workflow_id: str, repair_url: str, repair_hash: str) | immutable repair recipient | null |
| verify_repair(workflow_id: str) | anyone | null |
| expire_workflow(workflow_id: str) | anyone | null |

`report_json` is `{nodeId,impact,reporter}`. `evidence_json` is one EvidenceItem.
Identifiers are caller-chosen immutable protocol IDs (hash-shaped workflow/handoff
IDs, short node/duty/remedy/evidence IDs); they are not assumed to be their own hashes.

Funding receipt, strict JSON:

```json
{
  "schemaVersion": 1,
  "workflowId": "<manifest.id>",
  "workflowHash": "<canonical manifest SHA256>",
  "baseChainId": 84532,
  "escrowAddress": "<lowercase deployed Base escrow>",
  "tokenAddress": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  "genlayerChainId": 4221,
  "genlayerContract": "<this deployed GenLayer contract>",
  "bonds": {"<each participant>": "<exact manifest bond micro-units>"},
  "lockedAt": 1792022400,
  "expiresAt": 1792627200,
  "txHash": "<Base funding verification transaction hash>",
  "blockHash": "<finalized Base block hash>",
  "finalized": true,
  "success": true
}
```

The attestor must independently verify Base escrow deployment/configuration, workflow
hash, exact bonds, signed receipt references, finality and successful execution before
calling activation. `lockedAt` is the Base lock start; `expiresAt=lockedAt+604800`.
Effective expiry is the earlier of Base expiry and registration time plus seven days.
The attestor also admits snapshot acknowledgment transaction references, verifying each
native successful finalized transaction's caller and arguments. The contract verifies
these references cover exactly its own authenticated journal. This is a single-attestor
trust model; hashes and caps do not make it trustless. The attestor cannot choose findings,
remedies, allocations, or repair acceptance.

Snapshot and repair URLs must equal `evidence_origin + '/' + hash` exactly. Serve HTTP
200 canonical UTF-8 JSON bytes at that endpoint. Raw bytes are checked against the hash
before parsing, then checked for canonical encoding. Snapshots reproduce the exact
on-chain report, evidence order and handoff history, plus exactly the recorded acknowledgment
pairs with nonzero transaction hashes. Full artifact and reference text must exist in
evidence with its actual hash; a `sourceHash` claiming an excerpt is insufficient.

Repair submissions use RepairSubmissionSchema. Each new artifact needs its full hash-
matching evidence text. `previousHashes` equals the sorted unique latest ORIGINAL snapshot
artifact hashes of the chosen repair's nodes. If none were delivered, use `[workflowHash]`.
The submission is accepted only after cure ends and before the repair deadline. Exactly
one submission is allowed, including when verification rejects it.

Repair verdict strict schema: `{schemaVersion:1,workflowId,caseId,decisionId,repairHash,
remedyId,accepted:boolean,checks:[{nodeId,satisfied:boolean}],evidenceRefs:string[],rationale}`.
Checks cover exactly every chosen remedy node. `accepted` equals all checks satisfied.
Evidence references name submitted repair evidence. Validator agreement includes every
check, accepted, and all binding fields. Release requires a separate FINALIZED successful
`verify_repair` transaction and `repairAccepted === true` with exact verdict binding.
