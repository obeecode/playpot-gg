import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/context';
import type { Offer } from '../lib/types';
import { GAMES } from '../games/registry';
import { ChallengeDialog } from '../components/ChallengeDialog';

export function Lobby() {
  const { client, account, refreshAccount } = useApp();
  const navigate = useNavigate();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [selected, setSelected] = useState<Offer | null>(null);
  const [stake, setStake] = useState('10');
  const [published, setPublished] = useState<Offer | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => setOffers(await client.listOffers('tic-tac-toe')), [client]);
  useEffect(() => { void load(); }, [load]);

  const publish = async () => {
    setError('');
    try {
      const o = await client.createOffer('tic-tac-toe', Number(stake));
      setPublished(o);
      await Promise.all([load(), refreshAccount()]);
    } catch (e) { setError((e as Error).message); }
  };

  const n = Number(stake) || 0;
  return (
    <main className="page page-lobby">
      <section className="col-main">
        <h1 className="display">Pick a game. Match the pot.<br />Winner keeps it.</h1>
        <p className="lede">Every offer below is already funded. Challenge one and your matching stake locks in escrow, then the game starts.</p>
        <div className="section-head"><h2>Open offers</h2><span className="muted small">{GAMES['tic-tac-toe'].title}</span></div>
        <div className="stack">
          {offers === null && <p className="muted">Loading offers…</p>}
          {offers?.length === 0 && <p className="muted">No open offers yet. Create the first one.</p>}
          {offers?.map((o) => {
            const cant = !!account && o.stake > account.balance;
            return (
              <div className="row-card" key={o.id}>
                <div className="who">
                  <div className="avatar" aria-hidden="true">{o.owner[0].toUpperCase()}</div>
                  <div><Link to={`/p/${o.owner}`} className="strong">{o.owner}</Link><div className="muted small">Tic-tac-toe, single game</div></div>
                </div>
                <div className="stat"><div className="muted tiny">Each stakes</div><strong>{o.stake} tPOT</strong></div>
                <div className="stat"><div className="muted tiny">Pot</div><span className="pot-sm">{o.pot}</span></div>
                <button className="btn btn-primary" disabled={cant || o.owner === 'you'} onClick={() => setSelected(o)}>
                  {o.owner === 'you' ? 'Your offer' : cant ? 'Need more tPOT' : 'Challenge'}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <aside className="col-side">
        <div className="card">
          <h2>Create an offer</h2>
          <p className="muted small">Set a stake. Others challenge you with one click.</p>
          <label htmlFor="game">Game</label>
          <select id="game"><option>Tic-tac-toe</option></select>
          <label htmlFor="stake">Your stake (tPOT)</label>
          <input id="stake" type="number" min={1} value={stake} onChange={(e) => { setStake(e.target.value); setPublished(null); }} />
          <div className="between"><span className="muted small">Pot if challenged</span><span className="pot-inline">{n * 2} tPOT</span></div>
          <button className="btn btn-primary btn-block" onClick={publish}>Fund and publish offer</button>
          {published && <div className="note ok" role="status">Offer is live. {published.stake} tPOT is locked. Cancel any time before someone challenges for a full refund.</div>}
          {error && <div className="note bad" role="alert">{error}</div>}
        </div>
        <div className="card">
          <h2>How a pot works</h2>
          <ol className="steps">
            <li>Both stakes lock in escrow.</li>
            <li>You play. One signature at the start, then moves are silent.</li>
            <li>Winner claims the pot. A draw refunds both stakes.</li>
          </ol>
        </div>
      </aside>

      {selected && (
        <ChallengeDialog
          offer={selected}
          onCancel={() => setSelected(null)}
          onConfirm={async () => {
            const id = await client.challenge(selected.id);
            await refreshAccount();
            navigate(`/match/${id}`);
          }}
        />
      )}
    </main>
  );
}
