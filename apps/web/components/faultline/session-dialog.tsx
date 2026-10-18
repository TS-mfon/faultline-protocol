'use client';

import { ArrowRight, KeyRound, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Modal } from './primitives';
import type { Session } from './action-dialog';

type Challenge = { id: string; address: string; message: string; expiresAt: number };
type WalletProvider = { request: (request: { method: string; params?: unknown[] }) => Promise<unknown> };
function provider(): WalletProvider | undefined { return (window as Window & { ethereum?: WalletProvider }).ethereum; }
export function SessionDialog({ session, onSave, onClose }: { session: Session; onSave: (session: Session) => void; onClose: () => void }) {
  const [actor, setActor] = useState(session.actor), [token, setToken] = useState(''), [challenge, setChallenge] = useState<Challenge | null>(null), [signature, setSignature] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function requestChallenge(address: string) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Enter your complete wallet address.');
    const result = await api<Challenge>('/auth/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: address.toLowerCase() }) });
    if (!result?.id || result.address !== address.toLowerCase() || typeof result.message !== 'string' || result.expiresAt <= Date.now()) throw new Error('The service returned an invalid or expired challenge.');
    if (active.current) { setActor(address.toLowerCase()); setChallenge(result); setSignature(''); }
  }
  async function start(useWallet: boolean) {
    setBusy(true); setError('');
    try { let address = actor; if (useWallet) { const wallet = provider(); if (!wallet) throw new Error('No browser wallet detected. Enter your address below to sign using another wallet.'); const accounts = await wallet.request({ method: 'eth_requestAccounts' }); if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') throw new Error('Your wallet did not share an address.'); address = accounts[0]; } await requestChallenge(address); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Wallet connection was not completed.'); }
    finally { if (active.current) setBusy(false); }
  }
  async function verify(useWallet: boolean) {
    if (!challenge) return; setBusy(true); setError('');
    try {
      if (challenge.expiresAt <= Date.now()) throw new Error('This challenge has expired. Request a new one.');
      let signed: unknown = signature;
      if (useWallet) { const wallet = provider(); if (!wallet) throw new Error('No browser wallet detected. Paste a signature from your own wallet.'); const accounts = await wallet.request({ method: 'eth_accounts' }); if (!Array.isArray(accounts) || !accounts.some(account => typeof account === 'string' && account.toLowerCase() === challenge.address)) throw new Error('Select the challenged address in your wallet before signing.'); const hex = `0x${Array.from(new TextEncoder().encode(challenge.message), byte => byte.toString(16).padStart(2, '0')).join('')}`; signed = await wallet.request({ method: 'personal_sign', params: [hex, challenge.address] }); }
      if (typeof signed !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signed)) throw new Error('Enter a complete EOA personal-message signature.');
      const result = await api<{ address: string; token: string; expiresAt: number }>('/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: challenge.id, signature: signed }) });
      if (result?.address !== challenge.address || !result.token || result.expiresAt <= Date.now()) throw new Error('The service returned an invalid session.');
      if (active.current) { onSave({ actor: result.address, token: result.token, expiresAt: result.expiresAt }); onClose(); }
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Signature verification failed.'); } finally { if (active.current) setBusy(false); }
  }
  return <Modal title="Authorize an API session" onClose={onClose}><div className="fl-modal-body"><div className="fl-inline-note"><KeyRound size={20} /><p>Sign a service-issued authentication message with your own wallet. This authorizes API requests only. It does not authorize spending or chain transactions.</p></div>{challenge ? <><h3>Review the authentication message</h3><pre className="fl-code-block">{challenge.message}</pre><div className="fl-form-footer"><button className="fl-button" type="button" disabled={busy} onClick={() => setChallenge(null)}>New challenge</button><button className="fl-button fl-button-primary" type="button" disabled={busy} onClick={() => void verify(true)}><Wallet size={15} />{busy ? 'Awaiting wallet…' : 'Sign with wallet'}</button></div><details className="fl-auth-advanced"><summary>Use a signature from another wallet</summary><form className="fl-form" onSubmit={event => { event.preventDefault(); void verify(false); }}><label>Personal-message signature<textarea rows={3} value={signature} onChange={event => setSignature(event.target.value)} required placeholder="0x…" /></label><button className="fl-button" disabled={busy} type="submit">Verify signature</button></form></details></> : <><button type="button" className="fl-button fl-button-primary fl-wallet-connect" disabled={busy} onClick={() => void start(true)}><Wallet size={16} />{busy ? 'Connecting…' : 'Connect browser wallet'}</button><form className="fl-form" onSubmit={event => { event.preventDefault(); void start(false); }}><label>Or enter your wallet address<input value={actor} onChange={event => setActor(event.target.value)} pattern="0x[a-fA-F0-9]{40}" required placeholder="0x…" autoComplete="off" spellCheck={false} /></label><button type="submit" className="fl-button" disabled={busy}>Request authentication message<ArrowRight size={15} /></button></form><details className="fl-auth-advanced"><summary>Use an existing bearer session</summary><form className="fl-form" onSubmit={event => { event.preventDefault(); onSave({ actor: actor.toLowerCase(), token: token.trim() }); onClose(); }}><label>Wallet address<input value={actor} onChange={event => setActor(event.target.value)} pattern="0x[a-fA-F0-9]{40}" required autoComplete="off" /></label><label>Wallet-bound bearer token<input type="password" value={token} onChange={event => setToken(event.target.value)} required autoComplete="off" placeholder="Session token" /></label><p className="fl-muted">Use a token issued for this wallet. Never enter a private key or seed phrase.</p><button type="submit" className="fl-button">Use session</button></form></details></>}{error && <p role="alert" className="fl-form-error">{error}</p>}<p className="fl-session-disclosure">Credentials stay in this tab’s memory and are cleared on reload.</p>{session.token && <div className="fl-form-footer"><button type="button" className="fl-button" onClick={() => { onSave({ actor: '', token: '' }); onClose(); }}>Disconnect session</button></div>}</div></Modal>;
}
