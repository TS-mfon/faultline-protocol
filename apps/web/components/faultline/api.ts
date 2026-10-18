import { AmountSchema, DecisionSchema, HandoffManifestSchema, HashSchema, WorkflowManifestSchema, type Operation, type WorkflowRecord } from '@faultline/protocol';
import { statusLabels, type Audit } from './model';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { ...options, signal: options.signal ?? AbortSignal.timeout(20000), cache: 'no-store', headers: { Accept: 'application/json', ...options.headers } });
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === 'object' && 'error' in body) {
    const error = body.error as { code?: string; message?: string };
    throw new ApiError(error?.code ?? 'API_ERROR', error?.message ?? 'The service could not complete this request.', response.status);
  }
  if (!response.ok) throw new ApiError(`HTTP_${response.status}`, response.status === 404 ? 'The workflow service is not available.' : `The service returned HTTP ${response.status}.`, response.status);
  if (!body || typeof body !== 'object' || !('data' in body)) throw new ApiError('INVALID_ENVELOPE', 'The service returned an invalid response envelope.', response.status);
  return body.data as T;
}
export async function listWorkflows(signal?: AbortSignal): Promise<WorkflowRecord[]> {
  const result = await api<WorkflowRecord[]>('/workflows', { signal });
  if (!Array.isArray(result) || result.some(item => !isWorkflow(item))) throw new ApiError('INVALID_WORKFLOWS', 'The service returned an invalid workflow collection.', 200);
  return result;
}
export function isWorkflow(value: unknown): value is WorkflowRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as WorkflowRecord;
  return WorkflowManifestSchema.safeParse(record.manifest).success && HashSchema.safeParse(record.hash).success && typeof record.status === 'string' && Object.hasOwn(statusLabels, record.status) &&
    (record.mode === 'live' || record.mode === 'replay') && Array.isArray(record.handoffs) && record.handoffs.every(item => HandoffManifestSchema.safeParse(item).success) &&
    Array.isArray(record.accepted) && record.accepted.every(item => typeof item === 'string') && Array.isArray(record.suspendedNodes) &&
    record.suspendedNodes.every(item => typeof item === 'string') && Array.isArray(record.acknowledgments) && record.acknowledgments.every(item => item && typeof item.handoffId === 'string' && typeof item.agent === 'string' && typeof item.txHash === 'string') &&
    !!record.bonded && typeof record.bonded === 'object' && Object.values(record.bonded).every(item => AmountSchema.safeParse(item).success) &&
    typeof record.createdAt === 'string' && typeof record.expiresAt === 'string' && Number.isInteger(record.revision) &&
    (record.decision === undefined || DecisionSchema.safeParse(record.decision).success);
}
export const getWorkflow = (id: string, signal?: AbortSignal) => api<WorkflowRecord>(`/workflows/${encodeURIComponent(id)}`, { signal });
export const getAudit = (id: string, signal?: AbortSignal) => api<Audit>(`/workflows/${encodeURIComponent(id)}/audit`, { signal });
export const getOperation = (id: string, signal?: AbortSignal) => api<Operation>(`/operations/${encodeURIComponent(id)}`, { signal });
export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
