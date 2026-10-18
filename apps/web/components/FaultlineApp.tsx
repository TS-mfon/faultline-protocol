'use client';

import { Activity, ArrowDownToLine, ArrowRight, BookOpen, ChevronDown, CircleHelp, Code2, FlaskConical, GitBranch, Layers3, LoaderCircle, Menu, PackageCheck, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Users, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Operation, WorkflowRecord } from '@faultline/protocol';
import { downloadJson, getAudit, getWorkflow, isWorkflow, listWorkflows } from './faultline/api';
import { ActionDialog, SessionDialog, type Session } from './faultline/action-dialog';
import { EvidenceInspector } from './faultline/evidence-inspector';
import { Badge, CopyValue, Empty, Modal, ModeBadge } from './faultline/primitives';
import { domains, money, statusLabels, type Audit, type Domain, type Evidence, type View } from './faultline/model';
import { localReplays } from './faultline/replay';
import { AgentsView, ProtocolView } from './faultline/secondary-views';
import { TemplateDialog } from './faultline/template-dialog';
import { EvidencePanel, ReceiptsPanel, RepairSummary, TermsPanel } from './faultline/workflow-details';
import { WorkflowGraph } from './faultline/workflow-graph';

type Section = 'overview' | 'evidence' | 'receipts' | 'terms';
const domainIcons = { software: Code2, research: FlaskConical, procurement: PackageCheck };
const localRecords = localReplays.map(replay => replay.workflow);

/** Mount from the driver's route: import FaultlineApp from '../components/FaultlineApp'. */
export default function FaultlineApp({ initialView = 'workflows' }: { initialView?: View }) {
  const [compactNav, setCompactNav] = useState(false), [resumeOperation, setResumeOperation] = useState<Operation | undefined>();
  const sidebarRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<View>(initialView), [records, setRecords] = useState<WorkflowRecord[]>(localRecords), [connection, setConnection] = useState<'checking' | 'api' | 'offline'>('checking'), [connectionError, setConnectionError] = useState(''), [refreshVersion, setRefreshVersion] = useState(0), [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState(localRecords[0]!.manifest.id), [nodeId, setNodeId] = useState('produce'), [section, setSection] = useState<Section>('overview'), [explicitReplay, setExplicitReplay] = useState<Domain | null>(null);
  const [auditState, setAuditState] = useState<{ id: string; data: Audit; error: string } | null>(null), [auditLoading, setAuditLoading] = useState(false), [operationUpdates, setOperationUpdates] = useState<Record<string, Operation>>({}), [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'templates' | 'workflows' | 'session' | 'actions' | null>(null), [menuOpen, setMenuOpen] = useState(false), [search, setSearch] = useState(''), [domainFilter, setDomainFilter] = useState<Domain | 'all'>('all'), [session, setSession] = useState<Session>({ actor: '', token: '' });
  const mainRef = useRef<HTMLElement>(null);
  const chosenRecords = explicitReplay ? localRecords : records;
  const workflow = explicitReplay ? localRecords.find(record => record.manifest.domain === explicitReplay) : chosenRecords.find(record => record.manifest.id === selectedId) ?? chosenRecords[0];
  const local = !!explicitReplay || connection !== 'api';
  const selectedNode = workflow?.manifest.nodes.find(node => node.id === nodeId) ?? workflow?.manifest.nodes[0];
  const activeAudit = auditState?.id === workflow?.manifest.id ? auditState : null;
  const localData = local ? localReplays.find(replay => replay.workflow.manifest.id === workflow?.manifest.id) : undefined;
  const auditEvidence = activeAudit?.data.evidence;
  const evidence: Evidence[] = localData?.evidence ?? (Array.isArray(auditEvidence) ? auditEvidence.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.hash === 'string' && typeof item.submittedBy === 'string') : []);
  const receipts = Array.isArray(activeAudit?.data.receipts) ? activeAudit.data.receipts.filter(item => item && typeof item.transactionHash === 'string' && ['base', 'genlayer'].includes(item.chain) && ['success', 'reverted', 'pending', 'undetermined'].includes(item.execution) && ['finalized', 'pending'].includes(item.finality)) : [];
  const auditOps = activeAudit?.data.operations;
  const baseOperations = localData?.operations ?? (Array.isArray(auditOps) ? auditOps.filter(item => item?.id && ['queued', 'awaiting_signature', 'submitted', 'confirming', 'completed', 'failed'].includes(item.status)) : []);
  const operations = [...baseOperations.filter(item => !operationUpdates[item.id]), ...Object.values(operationUpdates).filter(item => item.workflowId === workflow?.manifest.id)];
  const filteredRecords = chosenRecords.filter(record => (domainFilter === 'all' || record.manifest.domain === domainFilter) && `${record.manifest.title} ${record.manifest.id}`.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    const controller = new AbortController();
    setRefreshing(true);
    listWorkflows(AbortSignal.any([controller.signal, AbortSignal.timeout(12000)])).then(result => { if (controller.signal.aborted) return; setRecords(result); setConnection('api'); setConnectionError(''); }).catch((cause: unknown) => { if (controller.signal.aborted) return; setConnection(previous => previous === 'api' ? 'api' : 'offline'); setConnectionError(cause instanceof Error ? cause.message : 'The service is unavailable.'); }).finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [refreshVersion]);

  useEffect(() => {
    if (!workflow || local) { setAuditLoading(false); return; }
    const controller = new AbortController(), id = workflow.manifest.id;
    setAuditLoading(true);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
    Promise.allSettled([getWorkflow(id, signal), getAudit(id, signal)]).then(([recordResult, auditResult]) => {
      if (controller.signal.aborted) return;
      if (recordResult.status === 'fulfilled' && isWorkflow(recordResult.value) && recordResult.value.manifest.id === id) setRecords(previous => previous.map(item => item.manifest.id === id ? recordResult.value : item));
      setAuditState({ id, data: auditResult.status === 'fulfilled' && auditResult.value && typeof auditResult.value === 'object' ? auditResult.value : {}, error: auditResult.status === 'rejected' ? (auditResult.reason instanceof Error ? auditResult.reason.message : 'Audit could not be loaded.') : '' });
      setAuditLoading(false);
    });
    return () => controller.abort();
  }, [workflow?.manifest.id, local, refreshVersion]);

  useEffect(() => { const handleKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setDialog('workflows'); } if (event.key === 'Escape') setMenuOpen(false); }; window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 800px)');
    const change = () => setCompactNav(media.matches); change(); media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!menuOpen || !compactNav) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    sidebarRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    function trap(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const items = sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)');
      if (!items?.length) return;
      const first = items[0]!, last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', trap);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [menuOpen, compactNav]);
  useEffect(() => {
    if (!session.expiresAt) return;
    const timer = setTimeout(() => { setSession({ actor: '', token: '' }); setNotice('Your API session expired. Reconnect your wallet to continue.'); }, Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [session.expiresAt]);

  function navigate(next: View) { setView(next); setMenuOpen(false); window.requestAnimationFrame(() => mainRef.current?.focus()); }
  function selectWorkflow(record: WorkflowRecord) { setSelectedId(record.manifest.id); if (explicitReplay) setExplicitReplay(record.manifest.domain); setNodeId(record.manifest.nodes.find(node => node.id === 'produce')?.id ?? record.manifest.nodes[0]?.id ?? ''); setSection('overview'); setDialog(null); navigate('workflows'); }
  function replay(domain: Domain) { setExplicitReplay(domain); setSection('overview'); setNodeId('produce'); navigate('workflows'); }
  function selectNode(id: string) { setNodeId(id); if (window.matchMedia('(max-width: 1100px)').matches) window.requestAnimationFrame(() => document.getElementById('fl-inspector')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })); }
  async function exportAudit() {
    if (!workflow) return;
    try {
      if (local) downloadJson(`faultline-${workflow.manifest.domain}-REPLAY.json`, { mode: 'replay', readOnly: true, disclosure: 'Local illustrative replay. No live transactions, balances, consensus, or finality.', workflow, snapshot: localData?.snapshot, evidence, operations });
      else downloadJson(`faultline-${workflow.manifest.id}-audit.json`, await getAudit(workflow.manifest.id, AbortSignal.timeout(12000)));
      setNotice('Audit downloaded.');
    } catch (cause) { setNotice(cause instanceof Error ? `Export failed: ${cause.message}` : 'Audit export failed.'); }
  }

  return <div className="fl-app"><a className="fl-skip-link" href="#fl-main">Skip to investigation</a>
    <aside ref={sidebarRef} inert={compactNav && !menuOpen} aria-hidden={compactNav && !menuOpen ? true : undefined} className={`fl-sidebar ${menuOpen ? 'is-open' : ''}`} id="fl-navigation" aria-label="Workspace navigation"><a className="fl-brand" href="#fl-main" onClick={() => navigate('workflows')} aria-label="Faultline workflows"><span className="fl-brand-mark" aria-hidden="true"><i /><i /><i /></span><span>faultline<span className="fl-brand-period">.</span></span><span className="fl-brand-version">v1</span></a><div className="fl-workspace-label"><span className="fl-workspace-avatar">F</span><div>Investigation console<small>Protocol workspace</small></div><ChevronDown size={14} aria-hidden="true" /></div><span className="fl-nav-label">WORKSPACE</span><nav aria-label="Primary">{([{ id: 'workflows', label: 'Workflows', icon: GitBranch }, { id: 'agents', label: 'Agents', icon: Users }, { id: 'protocol', label: 'Protocol', icon: BookOpen }] as const).map(item => <button type="button" key={item.id} className={view === item.id ? 'is-active' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={18} strokeWidth={1.6} />{item.label}{item.id === 'workflows' && <span className="fl-nav-count">{chosenRecords.length}</span>}</button>)}</nav><div className="fl-sidebar-divider" /><div className="fl-nav-label fl-nav-label-row"><span>EXPLORE A REPLAY</span><Badge>03</Badge></div><div className="fl-replay-nav">{domains.map(domain => { const Icon = domainIcons[domain]; return <button type="button" key={domain} className={local && workflow?.manifest.domain === domain && view === 'workflows' ? 'is-active' : ''} onClick={() => replay(domain)}><Icon size={16} /><span>{domain}</span><ArrowRight size={12} /></button>; })}</div><div className="fl-sidebar-note"><span className="fl-note-line" /><p>Every commitment<br />leaves a trace.</p><span>Follow it to recovery.</span></div><div className="fl-sidebar-bottom"><button type="button" className="fl-help-button" onClick={() => navigate('protocol')}><CircleHelp size={16} />How Faultline works<ArrowRight size={13} /></button><button type="button" className="fl-session-button" onClick={() => { setMenuOpen(false); setDialog('session'); }}><span className="fl-agent-avatar"><ShieldCheck size={16} /></span><span>{session.token ? 'API session ready' : 'Read-only access'}<small>{session.token ? 'Wallet-bound API session' : 'Authorize an API session'}</small></span><ChevronDown size={13} /></button></div></aside>
    {menuOpen && <button type="button" className="fl-menu-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <div className="fl-workspace" inert={compactNav && menuOpen}><header className="fl-topbar"><div><button type="button" className="fl-icon-button fl-mobile-menu" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-controls="fl-navigation" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button><span className="fl-topbar-workspace">Workspace</span><span className="fl-slash">/</span><strong>{view === 'workflows' ? 'Workflows' : view === 'agents' ? 'Agents' : 'Protocol'}</strong></div><div><button type="button" className="fl-search-trigger" onClick={() => setDialog('workflows')}><Search size={15} /><span>Find a workflow</span><kbd>⌘ K</kbd></button><span className={`fl-connection-dot ${connection === 'api' && !connectionError ? 'fl-teal' : 'fl-amber'}`} aria-hidden="true" /><span className="fl-topbar-status">{connection === 'checking' ? 'Connecting' : connection === 'api' ? connectionError ? 'Refresh failed' : 'API connected' : 'Local workspace'}</span></div></header>
    <main id="fl-main" className={`fl-main ${view !== 'workflows' ? 'fl-main-secondary' : ''}`} ref={mainRef} tabIndex={-1}>
      {view === 'workflows' && <><div className="fl-page-heading"><div><span className="fl-eyebrow">The accountability workspace</span><h1>Workflow investigation<span className="fl-heading-dot">.</span></h1><p>Follow the evidence. Find the broken commitment. Verify the repair.</p></div><button type="button" className="fl-button fl-button-primary" onClick={() => setDialog('templates')}><Plus size={16} />New workflow</button></div>
      <div className={`fl-mode-banner ${local ? '' : 'fl-live-banner'}`} role="status"><div><span className="fl-banner-icon">{local ? <Layers3 size={17} /> : <Activity size={17} />}</span><p><strong>{local ? 'Read-only replay' : 'Service workspace'}</strong><span>{local ? 'Illustrative records. No live transactions or funds.' : 'Record mode is shown per workflow. Check receipts for confirmation and finality.'}</span></p></div><button type="button" className="fl-text-button" disabled={refreshing} onClick={() => { setExplicitReplay(null); setRefreshVersion(value => value + 1); }}>{refreshing ? <LoaderCircle size={13} className="fl-spin" /> : <RefreshCw size={13} />}{refreshing ? 'Checking API' : local ? 'Check live service' : 'Refresh'}</button></div>
      {connectionError && <details className="fl-connection-details"><summary>{connection === 'api' ? 'Refresh failed; the last service response remains visible.' : 'Service unavailable; showing local replay.'}</summary><p>{connectionError}</p></details>}
      {!workflow || !selectedNode ? <div className="fl-panel"><Empty title="Your first workflow starts here">No workflows were returned by the service. Create one from a template or explore a read-only replay.</Empty><div className="fl-empty-actions"><button type="button" className="fl-button fl-button-primary" onClick={() => setDialog('templates')}>Choose a template<ArrowRight size={15} /></button></div></div> : <>
      <div className="fl-investigation-heading"><div><div className="fl-workflow-kicker"><span className="fl-eyebrow">{workflow.manifest.domain} / {workflow.caseId ? 'Case open' : 'Workflow'}</span><ModeBadge mode={workflow.mode} /></div><button type="button" className="fl-workflow-title" onClick={() => setDialog('workflows')}><h2>{workflow.manifest.title}</h2><ChevronDown size={18} /></button><div className="fl-workflow-meta"><CopyValue value={workflow.manifest.id} label="workflow ID" /><span>Manifest v{workflow.manifest.schemaVersion}</span><span>{workflow.manifest.nodes.length} mandates</span></div></div><div className="fl-investigation-tools"><Badge tone={['completed'].includes(workflow.status) ? 'teal' : ['unresolved', 'recovery_failed'].includes(workflow.status) ? 'coral' : 'amber'} dot>{statusLabels[workflow.status] ?? workflow.status}</Badge><button type="button" className="fl-button" onClick={() => void exportAudit()}><ArrowDownToLine size={14} />Export audit</button></div></div>
      <div className="fl-metric-strip"><div><span>Accepted agents</span><strong>{workflow.accepted.filter((address, index, all) => all.indexOf(address) === index).length}<small> / {new Set(workflow.manifest.nodes.map(node => node.agent)).size} agents</small></strong></div><div><span>{workflow.mode === 'replay' ? 'Replay bonded amount' : 'Recorded bonded amount'}</span><strong>{money(Object.values(workflow.bonded).filter(value => /^\d+$/.test(value)).reduce((sum, value) => sum + BigInt(value), 0n).toString())}<small> USDC</small></strong></div><div><span>Repair cap</span><strong>{money(workflow.manifest.repairCap)}<small> USDC</small></strong></div><div><span>{workflow.mode === 'replay' ? 'Illustrative outcome' : 'Recorded outcome'}</span><strong className="fl-outcome">{workflow.decision?.outcome.replaceAll('_', ' ') ?? 'Awaiting judgment'}<span className="fl-outcome-dot" /></strong></div></div>
      <div className="fl-investigation-layout"><div className="fl-investigation-content"><div className="fl-section-nav"><div aria-label="Investigation section">{(['overview', 'evidence', 'receipts', 'terms'] as const).map(item => <button type="button" key={item} aria-pressed={section === item} onClick={() => setSection(item)}>{item === 'overview' ? 'Overview' : item === 'evidence' ? 'Evidence' : item === 'receipts' ? 'Receipts' : 'Terms'}{item === 'evidence' && <span>{evidence.length}</span>}</button>)}</div><button type="button" className="fl-icon-button" onClick={() => { setResumeOperation(undefined); setDialog('actions'); }} aria-label="Workflow actions"><SlidersHorizontal size={16} /></button></div>
      {activeAudit?.error && <p className="fl-audit-error" role="status">Audit unavailable: {activeAudit.error} <button type="button" className="fl-text-button" onClick={() => setRefreshVersion(value => value + 1)}>Retry</button></p>}
      {section === 'overview' && <><WorkflowGraph workflow={workflow} selectedId={selectedNode.id} onSelect={selectNode} /><RepairSummary workflow={workflow} onDetails={() => setSection('terms')} /><section className="fl-case-summary"><div><span className="fl-eyebrow">{workflow.mode === 'replay' ? 'Replay case note' : 'Decision rationale'}</span><h3>{workflow.decision ? 'Where the commitment broke' : 'The record is still being written'}</h3><p>{workflow.decision?.rationale ?? 'Published handoffs and acknowledgments will build the execution record. Only a GenLayer judgment can classify responsibility.'}</p>{workflow.decision?.requestedEvidence.length ? <><h4>Requested evidence</h4><ul>{workflow.decision.requestedEvidence.map(item => <li key={item}>{item}</li>)}</ul></> : null}</div><button type="button" className="fl-text-button" onClick={() => setSection('receipts')}>View receipts<ArrowRight size={14} /></button></section></>}
      {section === 'evidence' && <EvidencePanel evidence={evidence} workflow={workflow} onSelect={selectNode} />}{section === 'receipts' && <ReceiptsPanel key={workflow.manifest.id} initialOperations={operations} workflow={workflow} receipts={receipts} onResume={operation => { setResumeOperation(operation); setDialog('actions'); }} />}{section === 'terms' && <TermsPanel workflow={workflow} />}
      </div><EvidenceInspector key={workflow.manifest.id} workflow={workflow} node={selectedNode} evidence={evidence} auditLoading={auditLoading} onNodeSelect={selectNode} /></div>
      </>}
      </>}
      {view === 'agents' && <AgentsView workflows={chosenRecords} />}{view === 'protocol' && <ProtocolView />}
      <footer className="fl-footer"><span><span className="fl-brand-mini" aria-hidden="true">╱</span> Faultline Protocol</span><span>Commitment → responsibility → recovery</span><button type="button" onClick={() => navigate('protocol')}>Trust & finality<ArrowRight size={12} /></button></footer>
    </main></div>
    {notice && <div role="status" className="fl-toast">{notice}<button type="button" className="fl-icon-button" onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={14} /></button></div>}
    {dialog === 'templates' && <TemplateDialog onClose={() => setDialog(null)} onReplay={replay} onCreated={() => { setExplicitReplay(null); setRefreshVersion(value => value + 1); }} session={session} apiAvailable={connection === 'api' && !connectionError} />}
    {dialog === 'session' && <SessionDialog session={session} onSave={setSession} onClose={() => setDialog(null)} />}
    {dialog === 'actions' && workflow && <ActionDialog workflow={workflow} session={session} initialOperation={resumeOperation} onClose={() => setDialog(null)} onOperation={operation => { setOperationUpdates(previous => ({ ...previous, [operation.id]: operation })); setSection('receipts'); if (operation.status === 'completed') setRefreshVersion(value => value + 1); }} />}
    {dialog === 'workflows' && <Modal title="Find a workflow" onClose={() => setDialog(null)} wide><div className="fl-modal-body"><label className="fl-search fl-search-large"><Search size={18} /><input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by title or workflow ID" aria-label="Search workflows" /></label><div className="fl-filter-buttons" aria-label="Filter workflow domain">{(['all', ...domains] as const).map(domain => <button key={domain} type="button" className="fl-button" aria-pressed={domainFilter === domain} onClick={() => setDomainFilter(domain)}>{domain}</button>)}</div><div className="fl-workflow-results">{filteredRecords.length ? filteredRecords.map(record => { const Icon = domainIcons[record.manifest.domain]; return <button type="button" key={record.manifest.id} onClick={() => selectWorkflow(record)}><Icon size={20} /><span><strong>{record.manifest.title}</strong><small>{record.manifest.nodes.length} mandates · {statusLabels[record.status]}</small></span><ModeBadge mode={record.mode} /><ArrowRight size={16} /></button>; }) : <Empty title="No matching workflows">Try a different title or choose another domain.</Empty>}</div></div></Modal>}
  </div>;
}
export { FaultlineApp };
