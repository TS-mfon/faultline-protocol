import type { Operation } from '@faultline/protocol';
import type { RunState } from './live';
import type { TaskOutput } from './tasks';

export function artifact(state: RunState, audit: any, kind: 'consensus' | 'recovery') {
  const tasks = kind === 'consensus' ? ['produce', 'review', 'publish'] : ['produce', 'review', 'publish', 'repair'];
  const agentRuns = tasks.map(task => {
    const run = state.work[task];
    if (run?.state !== 'complete' || !run.output) throw new Error('Cannot publish missing task output');
    return run.output;
  }) as TaskOutput[];
  if (kind === 'consensus') {
    const workflow = audit.workflow;
    // Keep only fields frozen at this judgment; later repair/cleanup steps cannot rewrite its artifact.
    audit = {
      mode: audit.mode,
      workflow: { mode: workflow.mode, manifest: workflow.manifest, hash: workflow.hash,
        ...(workflow.caseId ? { caseId: workflow.caseId } : {}), ...(workflow.decision ? { decision: workflow.decision } : {}) },
      operations: audit.operations.filter((operation: Operation) => operation.kind === 'adjudicate'),
      snapshots: audit.snapshots,
    };
  }
  return { schemaVersion: 1 as const, execution: 'deterministic-agents-with-genlayer-consensus' as const, domain: state.domain, runId: state.runId, audit, agentRuns };
}
