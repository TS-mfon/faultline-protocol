import { hashCanonical, hashText } from '@faultline/protocol';
import { domains, type Domain } from './scenarios';

export type TaskName = 'produce' | 'review' | 'publish' | 'repair';
export interface TaskRequest { domain: Domain; task: TaskName; source: string; upstream?: string }
export interface TaskOutput {
  mode: 'deterministic-task'; version: 1; input: TaskRequest; inputHash: string; text: string; outputHash: string;
}
const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid scenario quantity');
  return value;
}

/** Controlled work harness, NOT adjudication. Only the GenLayer contract judges duties and repairs. */
export function executeTask(input: TaskRequest): TaskOutput {
  if (!domains.includes(input.domain) || !['produce', 'review', 'publish', 'repair'].includes(input.task)) throw new Error('Unknown scenario task');
  const source = JSON.parse(input.source);
  let text: string;
  if (input.task === 'review') {
    // The controlled missed check. No fault labels or expected findings enter the artifact.
    text = JSON.stringify({ review: 'approved', result: JSON.parse(input.upstream ?? '') });
  } else if (input.task === 'publish') {
    const result = JSON.parse(input.upstream ?? '').result;
    if (!result) throw new Error('A reviewed upstream artifact is required');
    text = input.domain === 'software' ? `Search latency averages ${numeric(result.mean_ms)} milliseconds.` :
      input.domain === 'research' ? `The success rate improved by ${numeric(result.improvement_pp)} percentage points.` :
      `Draft recommendation: proceed with the approved ${numeric(result.landed_cost_usd)} USD purchase. No order has been placed.`;
  } else {
    const repair = input.task === 'repair';
    if (input.domain === 'software') {
      if (!Array.isArray(source.observations_seconds) || !source.observations_seconds.length) throw new Error('Latency observations are required');
      const mean = source.observations_seconds.map(numeric).reduce((a: number, b: number) => a + b, 0) / source.observations_seconds.length;
      const meanMs = rounded(mean * (repair ? 1000 : 1));
      text = JSON.stringify({ mean_ms: meanMs, ...(repair ? { review: 'Recomputed the mean from the source seconds and converted to milliseconds.', release_note: `Search latency averages ${meanMs} milliseconds.` } : {}) });
    } else if (input.domain === 'research') {
      const baseline = numeric(source.baseline_success_rate), current = numeric(source.new_success_rate);
      if (!baseline || baseline > 1 || current > 1) throw new Error('Valid success rates are required');
      const change = rounded((current - baseline) * 100 / (repair ? 1 : baseline));
      text = JSON.stringify({ improvement_pp: change, ...(repair ? { review: 'Independently subtracted the original rates; the metric is absolute percentage points.', briefing: `The success rate improved by ${change} percentage points.` } : {}) });
    } else {
      const goods = numeric(source.quantity) * numeric(source.unit_price_usd);
      const cost = rounded(goods + (repair ? numeric(source.shipping_usd) + numeric(source.tax_usd) : 0));
      const allowed = cost <= numeric(source.maximum_landed_cost_usd);
      text = JSON.stringify({ landed_cost_usd: cost, within_budget: allowed, ...(repair ? { review: 'Recomputed goods, freight and tax against the committed cap.', recommendation: allowed ? 'Draft recommendation is within the cap; no order placed.' : 'Do not purchase; seek a compliant quote.' } : {}) });
    }
  }
  return { mode: 'deterministic-task', version: 1, input, inputHash: hashCanonical(input), text, outputHash: hashText(text) };
}
