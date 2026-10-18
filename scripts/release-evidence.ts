import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BASE_CHAIN_ID, GENLAYER_CHAIN_ID, hashCanonical, hashText, substantiveDecision,
  validateDecision, validateSnapshot, validateWorkflow, type Operation,
} from '@faultline/protocol';
import type { ChainGateway } from '@faultline/service';
import type { ChainConfig, LiveChainGateway } from '@faultline/chain';
import { domains, makeManifest, scenarios, type Domain } from '../examples/src/scenarios';
import { executeTask, type TaskOutput } from '../examples/src/tasks';
import { verifyAudit } from '../examples/src/verify';

export class ReleaseEvidenceError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ReleaseEvidenceError'; }
}
function requireEvidence(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ReleaseEvidenceError(code);
}
export interface LiveArtifact {
  schemaVersion: 1;
  domain: Domain;
  runId: string;
  audit: any;
  execution: 'deterministic-agents-with-genlayer-consensus';
  agentRuns: TaskOutput[];
}
type EvidenceGateway = Pick<ChainGateway, 'getReceipt' | 'deployments'>;

/** These checks never turn a local status, a fixture, or a provider label into chain evidence. */
export function verifyDeploymentRecord(record: any, config: ChainConfig) {
  requireEvidence(record?.schemaVersion === 1, 'DEPLOYMENT_RECORD_MISSING');
  requireEvidence(record.base?.chainId === BASE_CHAIN_ID && record.genlayer?.chainId === GENLAYER_CHAIN_ID, 'DEPLOYMENT_CHAIN_MISMATCH');
  requireEvidence(record.base.address === config.escrowAddress && record.base.codeHash === config.baseCodeHash &&
    record.genlayer.address === config.genlayerAddress && record.genlayer.codeHash === config.genlayerCodeHash &&
    record.attestor === config.attestor && record.evidenceOrigin === config.evidenceOrigin, 'DEPLOYMENT_RECORD_MISMATCH');
  requireEvidence(/^0x[0-9a-f]{40}$/.test(record.deployer) && /^0x[0-9a-f]{40}$/.test(record.guardian) && [record.base, record.genlayer].every(chain => /^0x[0-9a-f]{64}$/.test(chain.transactionHash) && /^0x[0-9a-f]{64}$/.test(chain.blockHash) && /^[1-9][0-9]*$/.test(chain.blockNumber) && chain.finality === 'finalized' && chain.execution === 'success') && /^0x[0-9a-f]{64}$/.test(record.genlayer.submissionHash), 'DEPLOYMENT_TRANSACTIONS_MISSING');
}

function scenarioArtifact(artifact: LiveArtifact, domain: Domain, taskCount: number) {
  requireEvidence(artifact?.schemaVersion === 1 && artifact.domain === domain && /^[\w-]{1,64}$/.test(artifact.runId), 'SCENARIO_IDENTITY_MISSING');
  const audit = artifact.audit;
  requireEvidence(audit?.mode === 'live' && audit.workflow?.mode === 'live', 'REPLAY_IS_NOT_LIVE_EVIDENCE');
  const manifest = validateWorkflow(audit.workflow.manifest);
  requireEvidence(manifest.domain === domain && manifest.nodes.length === 3, 'SCENARIO_DOMAIN_MISMATCH');
  const expected = makeManifest(domain, {
    creator: manifest.creator,
    agents: manifest.nodes.map(node => node.agent) as [string, string, string],
    repairer: manifest.repairs[0].recipient,
  }, artifact.runId);
  requireEvidence(hashCanonical(manifest) === hashCanonical(expected) && audit.workflow.hash === hashCanonical(manifest), 'SCENARIO_TERMS_MISMATCH');
  requireEvidence(artifact.execution === 'deterministic-agents-with-genlayer-consensus' &&
    Array.isArray(artifact.agentRuns) && artifact.agentRuns.length === taskCount, 'LABELED_AGENT_RUNS_MISSING');
  for (const [index, run] of artifact.agentRuns.entries()) {
    requireEvidence(run?.mode === 'deterministic-task' && run.version === 1 && run.input?.domain === domain &&
      run.input.task === ['produce', 'review', 'publish', 'repair'][index] && run.input.source === scenarios[domain].source &&
      typeof run.text === 'string' && run.text.trim() && run.inputHash === hashCanonical(run.input) && run.outputHash === hashText(run.text), 'AGENT_RECORD_HASH_MISMATCH');
    requireEvidence(hashCanonical(executeTask(run.input)) === hashCanonical(run), 'AGENT_TASK_NOT_REPRODUCIBLE');
    if (index === 1 || index === 2) requireEvidence(run.input.upstream === artifact.agentRuns[index - 1].text, 'AGENT_INPUT_BINDING_MISMATCH');
  }
  return manifest;
}

export async function verifyConsensusArtifact(artifact: LiveArtifact, domain: Domain, gateway: EvidenceGateway) {
  const manifest = scenarioArtifact(artifact, domain, 3), audit = artifact.audit;
  requireEvidence(Array.isArray(audit.operations), 'ADJUDICATION_MISSING');
  const judgments = (audit.operations as Operation[]).filter(operation => operation.kind === 'adjudicate');
  requireEvidence(judgments.length === 1 && judgments[0].status === 'completed', 'ADJUDICATION_NOT_SUCCESSFUL');
  const operation = judgments[0], intent = operation.intent, deployment = gateway.deployments.genlayer;
  requireEvidence(operation.txHash && intent && deployment.verified && intent.chain === 'genlayer' &&
    intent.chainId === GENLAYER_CHAIN_ID && intent.to === deployment.address && intent.functionName === 'adjudicate', 'ADJUDICATION_TARGET_MISMATCH');
  const stored = audit.snapshots?.find((item: any) => item.hash === audit.workflow.decision?.snapshotHash);
  requireEvidence(stored?.snapshot, 'FROZEN_SNAPSHOT_MISSING');
  const snapshot = validateSnapshot(manifest, stored.snapshot);
  requireEvidence(stored.hash === hashCanonical(snapshot), 'SNAPSHOT_HASH_MISMATCH');
  const decision = validateDecision(manifest, snapshot, audit.workflow.decision), decisionHash = hashCanonical(decision);
  requireEvidence(intent.args[0] === manifest.id && intent.args[2] === stored.hash, 'ADJUDICATION_SNAPSHOT_MISMATCH');
  const receipt = await gateway.getReceipt(operation.txHash, intent);
  requireEvidence(receipt && receipt.transactionHash === operation.txHash && receipt.execution === 'success' && receipt.finality === 'finalized' &&
    receipt.chain === 'genlayer' && receipt.chainId === GENLAYER_CHAIN_ID && receipt.to === deployment.address && receipt.deploymentHash === deployment.codeHash &&
    receipt.functionName === 'adjudicate' && receipt.argsHash === hashCanonical(intent.args) && receipt.workflowId === manifest.id &&
    receipt.workflowHash === audit.workflow.hash && receipt.caseId === decision.caseId && receipt.snapshotHash === stored.hash && receipt.decisionHash === decisionHash,
  'ADJUDICATION_FINALITY_NOT_PROVEN');
  requireEvidence(hashCanonical((receipt.result as any)?.decision) === decisionHash, 'DECISION_DIFFERS_FROM_CHAIN');
  requireEvidence(snapshot.evidence.some(item => item.hash === hashText(scenarios[domain].source) && item.text === scenarios[domain].source), 'COMMITTED_SOURCE_MISSING');
  for (const [index, call] of artifact.agentRuns.entries()) {
    const node = manifest.nodes[index];
    requireEvidence(snapshot.handoffs.some(handoff => handoff.nodeId === node.id && handoff.producer === node.agent && handoff.artifact.hash === call.outputHash) &&
      snapshot.evidence.some(item => item.hash === call.outputHash && item.text === call.text), 'AGENT_ARTIFACT_NOT_IN_EVIDENCE');
  }
  // An evaluation expectation, never supplied to the judge or used as a substitute verdict.
  const expected = {
    outcome: 'DECIDED',
    findings: [
      { nodeId: 'produce', class: 'primary', dutyIds: ['accuracy'] },
      { nodeId: 'publish', class: 'downstream_consequence', dutyIds: [] },
      { nodeId: 'review', class: 'contributory', dutyIds: ['detect'] },
    ],
    edges: [{ from: 'produce', to: 'review' }, { from: 'review', to: 'publish' }], remedyId: 'correct',
  };
  requireEvidence(hashCanonical(substantiveDecision(decision)) === hashCanonical(expected), 'UNEXPECTED_SUBSTANTIVE_FINDINGS');
  return { domain, runId: artifact.runId, workflowId: manifest.id, transactionHash: operation.txHash, snapshotHash: stored.hash, decisionHash };
}

export async function verifyConsensusSet(artifacts: LiveArtifact[], gateway: EvidenceGateway) {
  const results = [], workflows = new Set<string>(), transactions = new Set<string>();
  requireEvidence(artifacts.length >= domains.length * 3, 'CONSENSUS_REQUIRES_THREE_ATTEMPTS_PER_DOMAIN');
  for (const domain of domains) {
    const attempts = artifacts.filter(artifact => artifact.domain === domain);
    requireEvidence(attempts.length >= 3, 'CONSENSUS_REQUIRES_THREE_ATTEMPTS_PER_DOMAIN');
    for (const attempt of attempts) {
      const verified = await verifyConsensusArtifact(attempt, domain, gateway);
      requireEvidence(!workflows.has(verified.workflowId) && !transactions.has(verified.transactionHash), 'CONSENSUS_ATTEMPT_REUSED');
      workflows.add(verified.workflowId); transactions.add(verified.transactionHash);
      results.push(verified);
    }
  }
  requireEvidence(results.length === artifacts.length, 'UNKNOWN_CONSENSUS_DOMAIN');
  return results;
}

export async function verifyDemonstration(artifact: LiveArtifact, domain: Domain, gateway: LiveChainGateway) {
  scenarioArtifact(artifact, domain, 4);
  const consensus = { ...artifact, agentRuns: artifact.agentRuns.slice(0, 3), audit: {
    ...artifact.audit, operations: artifact.audit.operations.filter((operation: Operation) => operation.kind === 'adjudicate'),
  } };
  await verifyConsensusArtifact(consensus, domain, gateway);
  const repair = artifact.agentRuns[3];
  requireEvidence(artifact.audit.repair?.artifacts?.some((item: any) => item.hash === repair.outputHash) &&
    artifact.audit.repair?.evidence?.some((item: any) => item.hash === repair.outputHash && item.text === repair.text), 'AGENT_REPAIR_NOT_IN_EVIDENCE');
  return verifyAudit(artifact.audit, gateway);
}

/** Coverage is necessary but never substitutes for rereading each recovery receipt. */
export function requireDemonstrationCoverage(artifacts: LiveArtifact[]) {
  requireEvidence(artifacts.length >= domains.length * 3 && domains.every(domain => artifacts.filter(artifact => artifact.domain === domain).length >= 3), 'RECOVERY_REQUIRES_THREE_ATTEMPTS_PER_DOMAIN');
  const ids = artifacts.map(artifact => {
    requireEvidence(domains.includes(artifact.domain), 'UNKNOWN_RECOVERY_DOMAIN');
    return scenarioArtifact(artifact, artifact.domain, 4).id;
  });
  requireEvidence(new Set(ids).size === ids.length, 'RECOVERY_ATTEMPT_REUSED');
  return ids;
}

/** Enumerate all attempts; never quietly select a convenient final file or discard failures. */
export async function readEvidence(root: string): Promise<LiveArtifact[]> {
  const result: LiveArtifact[] = [];
  for (const domain of domains) {
    let files;
    try { files = await readdir(join(root, domain), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      requireEvidence(file.isFile() && file.name.endsWith('.json'), 'UNEXPECTED_EVIDENCE_FILE');
      const artifact = JSON.parse(await readFile(join(root, domain, file.name), 'utf8')) as LiveArtifact;
      requireEvidence(artifact.domain === domain, 'SCENARIO_DOMAIN_MISMATCH'); result.push(artifact);
    }
  }
  return result;
}

export async function verifyPublicRelease(origin: string, repository: string, workflowIds: string[], fetcher: typeof fetch = fetch) {
  let publicUrl: URL, sourceUrl: URL;
  try { publicUrl = new URL(origin); sourceUrl = new URL(repository); }
  catch { throw new ReleaseEvidenceError('PUBLIC_RELEASE_URL_MISSING'); }
  requireEvidence(publicUrl.protocol === 'https:' && publicUrl.origin === origin && !publicUrl.username && !publicUrl.password, 'PUBLIC_ORIGIN_INVALID');
  requireEvidence(sourceUrl.protocol === 'https:' && sourceUrl.hostname === 'github.com' && /^\/[\w.-]+\/[\w.-]+\/?$/.test(sourceUrl.pathname) &&
    !sourceUrl.username && !sourceUrl.password && !sourceUrl.search && !sourceUrl.hash, 'PUBLIC_SOURCE_INVALID');
  const get = async (url: string) => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    requireEvidence(response.ok, 'PUBLIC_ENDPOINT_UNAVAILABLE'); return response;
  };
  const page = await get(origin);
  requireEvidence((page.headers.get('content-type') ?? '').includes('text/html') && /faultline/i.test(await page.text()), 'PUBLIC_APP_MISMATCH');
  const health = await (await get(`${origin}/api/v1/health`)).json() as any;
  requireEvidence(health.data?.configured === true, 'PUBLIC_API_NOT_CONFIGURED');
  const card = await (await get(`${origin}/.well-known/agent-card.json`)).json() as any;
  requireEvidence(card.name === 'Faultline Protocol' && card.supportedInterfaces?.some((entry: any) => entry.url === `${origin}/api/a2a` && entry.protocolVersion === '1.0'), 'PUBLIC_AGENT_CARD_MISMATCH');
  const workflows = await (await get(`${origin}/api/v1/workflows`)).json() as any;
  requireEvidence(Array.isArray(workflows.data) && workflowIds.length >= domains.length * 3 && new Set(workflowIds).size === workflowIds.length && workflowIds.every(id =>
    workflows.data.some((workflow: any) => workflow.manifest?.id === id && workflow.mode === 'live' && workflow.status === 'completed')), 'PUBLIC_VERIFIED_WORKFLOWS_MISSING');
  // GitHub API distinguishes an actual public source repository from a sign-in/marketing page.
  const source = await (await get(`https://api.github.com/repos${sourceUrl.pathname.replace(/\/$/, '')}`)).json() as any;
  requireEvidence(source.private === false && source.html_url === repository.replace(/\/$/, '') && source.default_branch, 'PUBLIC_SOURCE_UNAVAILABLE');
}
