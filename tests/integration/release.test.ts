import { expect, it, vi } from 'vitest';
import { hashCanonical, hashText, validateSnapshot, type Operation } from '@faultline/protocol';
import type { ChainGateway, GatewayReceipt } from '@faultline/service';
import { makeManifest, handoff, replay, scenarios, domains, type Domain } from '../../examples/src/scenarios';
import { executeTask, type TaskOutput } from '../../examples/src/tasks';
import { requireDemonstrationCoverage, verifyConsensusArtifact, verifyConsensusSet, verifyDemonstration, verifyDeploymentRecord, verifyPublicRelease, type LiveArtifact } from '../../scripts/release-evidence';

// Synthetic receipt responses test the release oracle; they are never exported as live evidence.
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const deployments = {
  base: { address: address(20), chainId: 84532, codeHash: hashText('mock Base runtime'), verified: true },
  genlayer: { address: address(21), chainId: 4221, codeHash: hashText('mock GenLayer source'), verified: true },
};
function attempt(domain: Domain, runId: string) {
  const manifest = makeManifest(domain, { creator: address(1), agents: [address(1), address(2), address(3)], repairer: address(4) }, runId);
  const agentRuns: TaskOutput[] = [], handoffs: ReturnType<typeof handoff>[] = [];
  for (const task of ['produce', 'review', 'publish'] as const) {
    agentRuns.push(executeTask({ domain, task, source: scenarios[domain].source, ...(agentRuns.length ? { upstream: agentRuns.at(-1)!.text } : {}) }));
    handoffs.push(handoff(manifest, handoffs.length, agentRuns.at(-1)!.text, handoffs, 'https://faultline.test/api/v1/evidence'));
  }
  const caseId = hashText(`mock-case:${manifest.id}`);
  const snapshot = validateSnapshot(manifest, { schemaVersion: 1, workflowId: manifest.id, workflowHash: hashCanonical(manifest), caseId, round: 1,
    report: { nodeId: 'publish', impact: 'Synthetic failure report for verifier tests.', reporter: manifest.creator }, handoffs,
    acknowledgments: handoffs.slice(0, 2).map((h, i) => ({ handoffId: h.id, agent: manifest.nodes[i + 1].agent, txHash: hashText(`mock-ack:${i}`) })),
    evidence: [{ id: 'reference', text: scenarios[domain].source, hash: hashText(scenarios[domain].source), submittedBy: manifest.creator },
      ...agentRuns.map((output, i) => ({ id: `artifact-${i}`, text: output.text, hash: output.outputHash, submittedBy: manifest.nodes[i].agent }))],
  });
  const decision = { ...replay(domain).decision, workflowId: manifest.id, caseId, snapshotHash: hashCanonical(snapshot), rationale: 'Mocked consensus solely for verifier regression tests.' };
  const time = '2026-10-17T00:00:00.000Z';
  const operation: Operation = { id: hashText(`mock-operation:${manifest.id}`), kind: 'adjudicate', status: 'completed', workflowId: manifest.id,
    txHash: hashText(`mock-judgment:${manifest.id}`), createdAt: time, updatedAt: time,
    intent: { chain: 'genlayer', chainId: 4221, to: deployments.genlayer.address, functionName: 'adjudicate', args: [manifest.id, `https://faultline.test/api/v1/evidence/${decision.snapshotHash}`, decision.snapshotHash] } };
  const artifact: LiveArtifact = { schemaVersion: 1, execution: 'deterministic-agents-with-genlayer-consensus', domain, runId, agentRuns,
    audit: { mode: 'live', workflow: { mode: 'live', manifest, hash: hashCanonical(manifest), decision, caseId, status: 'decided' },
      operations: [operation], snapshots: [{ hash: decision.snapshotHash, snapshot }] } };
  const receipt: GatewayReceipt = { transactionHash: operation.txHash!, chain: 'genlayer', chainId: 4221, to: deployments.genlayer.address, from: address(9),
    functionName: 'adjudicate', argsHash: hashCanonical(operation.intent!.args), value: '0', deploymentHash: deployments.genlayer.codeHash,
    blockHash: hashText('mock finalized block'), blockNumber: '123', execution: 'success', finality: 'finalized', workflowId: manifest.id, workflowHash: hashCanonical(manifest),
    caseId, snapshotHash: decision.snapshotHash, decisionHash: hashCanonical(decision), result: { decision } };
  return { artifact, receipt };
}
function fixture() {
  const attempts = domains.flatMap(domain => [1, 2, 3].map(n => attempt(domain, `mock-attempt-${n}`)));
  const receipts = new Map(attempts.map(item => [item.receipt.transactionHash, item.receipt]));
  const gateway: Pick<ChainGateway, 'deployments' | 'getReceipt'> = { deployments: structuredClone(deployments), getReceipt: vi.fn(async hash => receipts.get(hash) ?? null) };
  return { artifacts: attempts.map(item => item.artifact), receipts, gateway };
}

it('requires nine distinct finalized judgments across all domains and returns the observed identities', async () => {
  const { artifacts, gateway } = fixture();
  const result = await verifyConsensusSet(artifacts, gateway);
  expect(result).toHaveLength(9);
  expect(new Set(result.map(item => item.workflowId)).size).toBe(9);
  for (const domain of domains) expect(result.filter(item => item.domain === domain)).toHaveLength(3);
  expect(gateway.getReceipt).toHaveBeenCalledTimes(9);
});

it('rejects one showcase receipt, omitted domains and attempts relabeled as independent', async () => {
  const { artifacts, gateway } = fixture();
  await expect(verifyConsensusSet(artifacts.slice(0, 1), gateway)).rejects.toThrow('THREE_ATTEMPTS');
  await expect(verifyConsensusSet([...artifacts.slice(0, 6), ...artifacts.slice(0, 3)], gateway)).rejects.toThrow();
  artifacts[1] = structuredClone(artifacts[0]);
  await expect(verifyConsensusSet(artifacts, gateway)).rejects.toThrow('ATTEMPT_REUSED');
});

it.each(['replay', 'pending', 'failed', 'source', 'task', 'record', 'snapshot', 'deployment', 'receipt', 'decision', 'expectation'])('rejects %s evidence even when the artifact says the run succeeded', async fault => {
  const { artifacts, receipts, gateway } = fixture(), target = artifacts[0], audit = target.audit;
  const receipt = receipts.get(audit.operations[0].txHash)!;
  if (fault === 'replay') audit.mode = 'replay';
  if (fault === 'pending') receipt.finality = 'pending';
  if (fault === 'failed') audit.operations[0].status = 'failed';
  if (fault === 'source') target.agentRuns[0].input.source = '{}';
  if (fault === 'task') target.agentRuns[1].input.upstream = '{}';
  if (fault === 'record') target.agentRuns[0].text = 'Changed artifact';
  if (fault === 'snapshot') audit.snapshots[0].snapshot.evidence[0].text = 'Changed evidence';
  if (fault === 'deployment') gateway.deployments.genlayer.verified = false;
  if (fault === 'receipt') receipt.workflowId = hashText('unrelated workflow');
  if (fault === 'decision') receipt.decisionHash = hashText('unrelated decision');
  if (fault === 'expectation') {
    audit.workflow.decision.findings[2].class = 'excused';
    receipt.decisionHash = hashCanonical(audit.workflow.decision);
    receipt.result = { decision: audit.workflow.decision };
  }
  await expect(verifyConsensusArtifact(target, 'software', gateway)).rejects.toThrow();
});

it('requires a real repair payment even after consensus and deterministic repair work are present', async () => {
  const { artifacts, gateway } = fixture(), candidate = artifacts[0];
  const repair = executeTask({ domain: 'software', task: 'repair', source: scenarios.software.source });
  candidate.agentRuns.push(repair); candidate.audit.workflow.status = 'completed';
  candidate.audit.repair = { artifacts: [{ hash: repair.outputHash }], evidence: [{ hash: repair.outputHash, text: repair.text }] };
  await expect(verifyDemonstration(candidate, 'software', gateway as any)).rejects.toThrow('Missing reserve');
});

it('requires a separate recovery for all nine attempts and rejects missing or reused runs before receipt verification', () => {
  const { artifacts } = fixture();
  for (const artifact of artifacts) artifact.agentRuns.push(executeTask({ domain: artifact.domain, task: 'repair', source: scenarios[artifact.domain].source }));
  expect(requireDemonstrationCoverage(artifacts)).toHaveLength(9);
  expect(() => requireDemonstrationCoverage(artifacts.filter((_, index) => index % 3 === 0))).toThrow('THREE_ATTEMPTS');
  expect(() => requireDemonstrationCoverage(artifacts.slice(1))).toThrow('THREE_ATTEMPTS');
  artifacts[1] = structuredClone(artifacts[0]);
  expect(() => requireDemonstrationCoverage(artifacts)).toThrow('ATTEMPT_REUSED');
});

it('binds deployment records to both chain identities, the attestor and the evidence origin', () => {
  const config = { escrowAddress: deployments.base.address, baseCodeHash: deployments.base.codeHash, genlayerAddress: deployments.genlayer.address,
    genlayerCodeHash: deployments.genlayer.codeHash, attestor: address(9), evidenceOrigin: 'https://faultline.test/api/v1/evidence' } as any;
  const receipt = { transactionHash: hashText('mock deployment transaction'), blockHash: hashText('mock deployment block'), blockNumber: '123', finality: 'finalized', execution: 'success' };
  const record = { schemaVersion: 1, base: { ...deployments.base, ...receipt }, genlayer: { ...deployments.genlayer, ...receipt, submissionHash: hashText('mock submission') }, deployer: address(1), guardian: address(1), attestor: config.attestor, evidenceOrigin: config.evidenceOrigin };
  expect(() => verifyDeploymentRecord(record, config)).not.toThrow();
  expect(() => verifyDeploymentRecord({ ...record, base: deployments.base }, config)).toThrow('DEPLOYMENT_TRANSACTIONS_MISSING');
  for (const altered of [{ ...record, base: { ...record.base, chainId: 8453 } }, { ...record, attestor: address(8) }, { ...record, evidenceOrigin: 'https://another.test/evidence' }])
    expect(() => verifyDeploymentRecord(altered, config)).toThrow();
});

it('public release must expose the exact independently verified completed workflows', async () => {
  const ids = domains.flatMap(domain => [1, 2, 3].map(attempt => hashText(`mock-${domain}-${attempt}`))), origin = 'https://faultline.test', repository = 'https://github.com/example/faultline';
  let configured = true, listed = ids;
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const value = String(url);
    if (value === origin) return new Response('<html>Faultline</html>', { headers: { 'content-type': 'text/html' } });
    if (value.endsWith('/health')) return Response.json({ data: { configured } });
    if (value.endsWith('/agent-card.json')) return Response.json({ name: 'Faultline Protocol', supportedInterfaces: [{ url: `${origin}/api/a2a`, protocolVersion: '1.0' }] });
    if (value.endsWith('/workflows')) return Response.json({ data: listed.map(id => ({ manifest: { id }, mode: 'live', status: 'completed' })) });
    return Response.json({ private: false, html_url: repository, default_branch: 'main' });
  }) as typeof fetch;
  await expect(verifyPublicRelease(origin, repository, ids, fetcher)).resolves.toBeUndefined();
  configured = false; await expect(verifyPublicRelease(origin, repository, ids, fetcher)).rejects.toThrow('NOT_CONFIGURED');
  configured = true; listed = [hashText('unrelated completed workflow')];
  await expect(verifyPublicRelease(origin, repository, ids, fetcher)).rejects.toThrow('VERIFIED_WORKFLOWS');
});
