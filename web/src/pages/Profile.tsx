import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../lib/context';
import type { PlayerProfile, Offer } from '../lib/types';
import { GAMES } from '../games/registry';
import { ChallengeDialog } from '../components/ChallengeDialog';

export function Profile() {
  const { handle = 'you' } = useParams();
  const { client, refreshAccount } = useApp();
  const navigate = useNavigate();
  const [p, setP] = useState<PlayerProfile | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);

  useEffect(() => { setP(null); void client.getPlayer(handle).then(setP); }, [client, handle]);

  const challenge = async (offerId: string) => {
    const all = await client.listOffers('tic-tac-toe');
    const o = all.find((x) => x.id === offerId);
    if (o) setOffer(o);
  };

  if (!p) return <main className="page"><p className="muted">Loading…</p></main>;
  return (
    <main className="page page-narrow">
      <Link to="/lobby" className="muted small">Back to lobby</Link>
      <section className="profile-head">
        <div className="avatar avatar-lg" aria-hidden="true">{p.handle[0].toUpperCase()}</div>
        <div>
          <h1 className="display-md">{p.handle}{p.isYou && <span className="muted small"> (you)</span>}</h1>
          <div className="muted small">{p.address.slice(0, 6)}…{p.address.slice(-4)}</div>
        </div>
      </section>

      <div className="section-head"><h2>{p.isYou ? 'Your games' : 'Their games'}</h2><span className="muted small">{p.isYou ? 'Offers you have published.' : `Preset by ${p.handle}. Click Challenge to play.`}</span></div>
      <div className="grid-2">
        {p.games.map((g) => {
          const mod = GAMES[g.game];
          const live = mod.available && !!g.offerId;
          return (
            <div className="card game-card" key={g.game}>
              <div className="between top">
                <div><div className="display-sm">{mod.title}</div><div className="muted small">{mod.available ? (live ? 'Live now' : 'No open offer') : 'Coming after tic-tac-toe'}</div></div>
                <div className="right"><div className="muted tiny">Pot</div><div className={'pot-lg' + (live ? '' : ' dim')}>{g.stake * 2}</div></div>
              </div>
              <div className="chips"><span>Stake {g.stake} each</span><span>Single game</span><span>{g.settleWindowMin} min settle window</span></div>
              <button className="btn btn-primary" disabled={!live || p.isYou} onClick={() => g.offerId && challenge(g.offerId)}>
                {!mod.available ? 'Not available yet' : p.isYou ? 'Your offer' : live ? 'Challenge' : 'No open offer'}
              </button>
            </div>
          );
        })}
      </div>

      <h2 className="mt">Recent matches</h2>
      <div className="stack">
        {p.recent.map((m, i) => (
          <div className="row-card" key={i}>
            <div className="grow">vs <strong>{m.vs}</strong><span className="muted small"> · Tic-tac-toe</span></div>
            <div className={'result ' + m.result}>{m.result === 'won' ? 'Won' : m.result === 'lost' ? 'Lost' : 'Draw, refunded'}</div>
            <div className="stat">{m.pot} pot</div>
            <Link to={`/match/${m.id}`} className="link-gold">Replay</Link>
          </div>
        ))}
      </div>

      {offer && (
        <ChallengeDialog offer={offer} onCancel={() => setOffer(null)} onConfirm={async () => {
          const id = await client.challenge(offer.id);
          await refreshAccount();
          navigate(`/match/${id}`);
        }} />
      )}
    </main>
  );
}
