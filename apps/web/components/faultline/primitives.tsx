'use client';

import { Check, Copy, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { shortId, type Tone } from './model';

export function Badge({ children, tone = 'neutral', dot = false }: { children: ReactNode; tone?: Tone; dot?: boolean }) { return <span className={`fl-badge fl-${tone}`}>{dot && <span className="fl-dot" aria-hidden="true" />}{children}</span>; }
export function ModeBadge({ mode }: { mode: 'live' | 'replay' }) { return <Badge tone={mode === 'live' ? 'teal' : 'amber'} dot>{mode.toUpperCase()}</Badge>; }
export function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="fl-empty"><span className="fl-empty-mark" aria-hidden="true">∅</span><h3>{title}</h3><p>{children}</p></div>; }
export function CopyValue({ value, label = 'identifier', full = false }: { value: string; label?: string; full?: boolean }) {
  const [message, setMessage] = useState('');
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 2500); return () => clearTimeout(timer); }, [message]);
  async function copy() { try { await navigator.clipboard.writeText(value); setMessage('Copied'); } catch { setMessage('Copy unavailable. Select the text to copy.'); } }
  return <span className="fl-copy"><code title={value}>{full ? value : shortId(value)}</code><button type="button" className="fl-icon-button" aria-label={`Copy ${label}`} onClick={copy}>{message === 'Copied' ? <Check size={13} /> : <Copy size={13} />}</button><span className="fl-sr-only" role="status">{message}</span></span>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; const previous = document.activeElement as HTMLElement | null; dialog?.showModal(); return () => { dialog?.close(); previous?.focus(); }; }, []);
  return <dialog ref={ref} className={`fl-modal${wide ? ' fl-modal-wide' : ''}`} aria-label={title} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><div className="fl-modal-heading"><h2>{title}</h2><button type="button" className="fl-icon-button" onClick={onClose} aria-label="Close dialog"><X size={19} /></button></div>{children}</dialog>;
}
