'use client';

import { ArrowRight, Check, GitBranch, List, Network, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { Mandate, WorkflowRecord } from '@faultline/protocol';
import { Badge } from './primitives';
import { nodeState, shortId } from './model';

function layout(nodes: Mandate[]) {
  const levels = new Map<string, number>();
  function level(id: string, seen = new Set<string>()): number {
    if (levels.has(id)) return levels.get(id)!;
    const node = nodes.find(item => item.id === id);
    if (!node || seen.has(id)) return 0;
    const visited = new Set(seen).add(id);
    const value = node.dependencies.length ? Math.max(...node.dependencies.map(dep => level(dep, visited))) + 1 : 0;
    levels.set(id, value); return value;
  }
  nodes.forEach(node => level(node.id));
  const max = Math.max(0, ...levels.values());
  const maxRows = Math.max(1, ...Array.from({ length: max + 1 }, (_, col) => nodes.filter(node => levels.get(node.id) === col).length));
  const height = Math.max(338, maxRows * 146 + 80), width = (max + 1) * 196 + 32;
  const positions = new Map(nodes.map(node => { const col = levels.get(node.id)!; const peers = nodes.filter(item => levels.get(item.id) === col); return [node.id, { x: col * 196 + 24, y: (height - peers.length * 146) / 2 + peers.indexOf(node) * 146 }] as const; }));
  return { positions, width, height };
}
export function WorkflowGraph({ workflow, selectedId, onSelect }: { workflow: WorkflowRecord; selectedId: string; onSelect: (id: string) => void }) {
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const { nodes } = workflow.manifest, { positions, width, height } = layout(nodes);
  return <section className="fl-panel fl-graph-panel" aria-labelledby="fl-graph-title">
    <div className="fl-panel-heading"><div><span className="fl-eyebrow">Follow the dependency</span><h2 id="fl-graph-title">Mandate graph <span className="fl-count">{nodes.length}</span></h2></div><div className="fl-segment" aria-label="Graph display"><button type="button" aria-pressed={view === 'graph'} onClick={() => setView('graph')}><Network size={14} />Graph</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={14} />List</button></div></div>
    {view === 'graph' ? <div className="fl-graph-scroll" tabIndex={0} role="region" aria-label="Scrollable workflow dependency graph. Select a mandate to inspect. Use List for a text view."><div className="fl-graph-canvas" style={{ width: Math.max(650, width), height }}>
      <svg className="fl-graph-lines" width="100%" height="100%" aria-hidden="true"><defs><pattern id="fl-grid-dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65" fill="#45503c" opacity=".65" /></pattern><marker id="fl-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="currentColor" /></marker></defs><rect width="100%" height="100%" fill="url(#fl-grid-dots)" />{nodes.flatMap(node => node.dependencies.map(dependency => { const from = positions.get(dependency), to = positions.get(node.id); if (!from || !to) return null; const causal = workflow.decision?.edges.some(edge => edge.from === dependency && edge.to === node.id); const selected = dependency === selectedId || node.id === selectedId; return <path key={`${dependency}-${node.id}`} d={`M ${from.x + 164} ${from.y + 57} C ${from.x + 182} ${from.y + 57}, ${to.x - 18} ${to.y + 57}, ${to.x - 4} ${to.y + 57}`} className={`${causal ? 'fl-causal-edge' : ''} ${selected ? 'fl-selected-edge' : ''}`} markerEnd="url(#fl-arrow)" />; }))}</svg>
      {nodes.map((node, index) => { const state = nodeState(workflow, node), pos = positions.get(node.id)!; return <button key={node.id} type="button" className={`fl-graph-node fl-node-${state.tone} ${node.id === selectedId ? 'is-selected' : ''}`} style={{ left: pos.x, top: pos.y }} aria-pressed={node.id === selectedId} aria-label={`${node.title}. ${state.label}. ${node.dependencies.length ? `Depends on ${node.dependencies.join(', ')}.` : 'Root mandate.'} Inspect details.`} onClick={() => onSelect(node.id)}><span className="fl-node-top"><span className="fl-node-index">M{String(index + 1).padStart(2, '0')}</span>{state.tone === 'teal' ? <ShieldCheck size={15} /> : <GitBranch size={14} />}</span><strong>{node.title}</strong><span className="fl-node-state"><span className="fl-dot" />{state.label}</span></button>; })}
      <span className="fl-graph-caption"><span className="fl-dot" /> {workflow.decision ? 'Causal paths shown from the recorded decision' : 'Edges follow accepted mandate dependencies'}</span>
    </div></div> : <ol className="fl-mandate-list">{nodes.map((node, index) => { const state = nodeState(workflow, node); return <li key={node.id}><button type="button" className={selectedId === node.id ? 'is-selected' : ''} aria-pressed={selectedId === node.id} onClick={() => onSelect(node.id)}><span className="fl-node-index">M{String(index + 1).padStart(2, '0')}</span><span><strong>{node.title}</strong><small>{node.dependencies.length ? `Depends on ${node.dependencies.map(id => nodes.find(item => item.id === id)?.title ?? id).join(' + ')}` : 'Root mandate · no dependencies'}<br />{shortId(node.agent)}</small></span><Badge tone={state.tone}>{state.label}</Badge><ArrowRight size={14} /></button></li>; })}</ol>}
    <div className="fl-graph-footer"><div className="fl-legend"><span><i className="fl-dot fl-amber" />Primary</span><span><i className="fl-dot fl-coral" />Contributory</span><span><i className="fl-dot fl-teal" />Excused</span><span><i className="fl-dot" />Downstream / pending</span></div><span className="fl-muted"><Check size={12} />{nodes.reduce((count, node) => count + node.dependencies.length, 0)} dependencies</span></div>
  </section>;
}
