import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../lib/context';
import type { MatchState, SettleAction } from '../lib/types';
import { GAMES } from '../games/registry';

const OUTCOME = {
  won: { title: (m: MatchState) => `You won ${m.pot} tPOT`, cls: 'ok', body: 'All three signatures match, so the pot is paid out instantly. Claim it to your wallet.', action: 'claim' as SettleAction, label: 'Claim pot', doneLabel: 'Claimed. Check your balance.' },
  lost: { title: (m: MatchState) => `${m.opponent.handle} won the pot`, cls: 'bad', body: 'Sign to confirm and pay out now. If you do nothing, the winner can claim after the settle window.', action: 'sign' as SettleAction, label: 'Sign result and pay out', doneLabel: 'Signed. They can claim now.' },
  draw: { title: () => 'Draw', cls: 'neutral', body: 'Neither side wins. Both stakes are refunded in full, no fee.', action: 'claim' as SettleAction, label: 'Claim refund', doneLabel: 'Refunded. Check your balance.' },
};

export function Match() {
  const { id = '' } = useParams();
  const { client, refreshAccount } = useApp();
  const [m, setM] = useState<MatchState | null>(null);
  const [step, setStep] = useState<number | null>(null); // null = latest
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setM(null); setStep(null);
    void client.getMatch(id).then((x) => live && setM(x));
    const off = client.subscribeMatch(id, (x) => live && setM(x));
    return () => { live = false; off(); };
  }, [client, id]);

  if (!m) return <main className="page"><p className="muted">Loading match…</p></main>;

  const game = GAMES[m.game];
  const over = m.status !== 'playing';
  const total = m.moves.length;
  const shown = step ?? total;
  const youMove = !over && !m.waiting;
  let status = 'Your move';
  if (m.waiting) status = `${m.opponent.handle} is moving…`;
  if (m.status === 'won') status = 'You win the pot';
  if (m.status === 'lost') status = `${m.opponent.handle} wins the pot`;
  if (m.status === 'draw') status = 'Draw';

  const act = async (a: SettleAction) => {
    setBusy(true);
    try { await client.settle(m.id, a); await refreshAccount(); } finally { setBusy(false); }
  };
  const o = over ? OUTCOME[m.status as 'won' | 'lost' | 'draw'] : null;
  const done = m.settlement !== 'open';

  return (
    <main className="page page-match">
      <section className="pot-bar">
        <div className="who"><div className="avatar" aria-hidden="true">Y</div><div><strong>You, playing {m.you.mark}</strong><div className="muted small">Staked {m.stake} tPOT</div></div></div>
        <div className="center"><div className="muted tiny kicker">POT, WINNER KEEPS IT</div><div className="pot-xl">{m.pot} tPOT</div></div>
        <div className="who right"><div><strong>{m.opponent.handle}, playing {m.opponent.mark}</strong><div className="muted small">Staked {m.stake} tPOT</div></div><div className="avatar" aria-hidden="true">{m.opponent.handle[0].toUpperCase()}</div></div>
      </section>

      <div className="match-grid">
        <section className="board-col">
          <div className="status" role="status">{status}</div>
          <game.Board moves={m.moves} step={shown} interactive={youMove && shown === total} youMark={m.you.mark} onMove={(c) => void client.makeMove(m.id, c)} />
          {over && (
            <div className="replay">
              <button className="btn btn-ghost" disabled={shown === 0} onClick={() => setStep(Math.max(0, shown - 1))}>Back</button>
              <span className="muted small">Replay: move {shown} of {total}</span>
              <button className="btn btn-ghost" disabled={shown === total} onClick={() => setStep(shown + 1 >= total ? null : shown + 1)}>Next</button>
            </div>
          )}
          <p className="muted small center-text">Your moves are signed silently by this match's key. Log hash {m.logHash} commits to the whole game.</p>
        </section>

        <aside className="side-col">
          {!over && (
            <div className="card"><h2>Match in progress</h2><p className="small">Both stakes are locked in escrow. Get three in a row to win the pot. A full board with no line is a draw and refunds both stakes.</p></div>
          )}
          {o && (
            <div className={'card outcome ' + o.cls}>
              <div className="muted tiny kicker">RESULT</div>
              <h2 className="display-sm">{o.title(m)}</h2>
              <p className="small">{o.body}</p>
              <button className="btn btn-primary" disabled={done || busy} onClick={() => act(o.action)}>{done ? o.doneLabel : o.label}</button>
              {m.status === 'lost' && (
                <>
                  <button className="btn btn-ghost" disabled={m.settlement === 'disputed' || busy} onClick={() => act('dispute')}>Dispute the result</button>
                  {m.settlement === 'disputed' && <div className="note warn" role="status">Funds are frozen. The contract will replay both players' signed moves on-chain and decide.</div>}
                </>
              )}
              <Link to="/lobby" className="btn btn-ghost">Back to lobby</Link>
            </div>
          )}
          <div className="card">
            <h2 className="h-sm">If something goes wrong</h2>
            <dl className="help">
              <div><dt>Opponent goes silent</dt><dd>The result stands after a {m.settleWindowMin} minute window.</dd></div>
              <div><dt>You disagree</dt><dd>Dispute it. Funds freeze and the signed moves replay on-chain.</dd></div>
              <div><dt>Nothing settles by the deadline</dt><dd>Anyone can abort and both stakes are refunded in full.</dd></div>
            </dl>
          </div>
        </aside>
      </div>
    </main>
  );
}
