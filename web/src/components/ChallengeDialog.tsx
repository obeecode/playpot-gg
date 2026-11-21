import { useEffect, useRef, useState } from 'react';
import type { Offer } from '../lib/types';

interface Props {
  offer: Offer;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function ChallengeDialog({ offer, onCancel, onConfirm }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const go = async () => {
    setBusy(true); setErr('');
    try { await onConfirm(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="overlay" onClick={() => !busy && onCancel()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="dlg-title" className="display-sm">Challenge {offer.owner}</h2>
        <p className="muted small">Tic-tac-toe, single game.</p>
        <dl className="facts">
          <div><dt>Your stake, locked now</dt><dd>{offer.stake} tPOT</dd></div>
          <div><dt>Pot</dt><dd className="gold">{offer.pot} tPOT</dd></div>
          <div><dt>Platform fee (fixed, capped on-chain)</dt><dd>[RAKE %]</dd></div>
          <div><dt>If it is a draw</dt><dd>Both stakes refunded</dd></div>
        </dl>
        <p className="muted small">You sign once to start the match. After that your moves are signed silently, with no more wallet popups.</p>
        {err && <div className="note bad" role="alert">{err}</div>}
        <div className="dialog-actions">
          <button ref={cancelRef} className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Waiting for signature…' : `Lock ${offer.stake} tPOT and play`}</button>
        </div>
      </div>
    </div>
  );
}
