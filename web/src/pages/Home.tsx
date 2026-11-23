import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/context';
import type { Offer } from '../lib/types';
import { GAMES } from '../games/registry';

const STEPS = [
  { t: 'Pick an offer', d: 'Every offer is already funded by the player who made it, so there is nobody to wait for.' },
  { t: 'Match the pot', d: 'One click locks your matching stake in escrow. You sign once, then your moves are silent.' },
  { t: 'Winner keeps it', d: 'The winner claims the pot. A draw refunds both stakes in full.' },
];

export function Home() {
  const { client } = useApp();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  useEffect(() => { void client.listOffers('tic-tac-toe').then(setOffers); }, [client]);

  return (
    <>
      <main className="page page-home">
        <section className="hero">
          <span className="pill"><span className="dot" aria-hidden="true" />Testnet live · {GAMES['tic-tac-toe'].title}</span>
          <h1 className="display">Challenge anyone.<br />Winner keeps the pot.</h1>
          <p className="lede">PlayPot.GG is a simple arena: players, games, and a pre-set pot for every game. Find an offer, match the stake, and play for it.</p>
          <div className="cta-row">
            <Link to="/lobby" className="btn btn-primary">Browse open offers</Link>
            <a href="#how" className="btn btn-ghost">How it works</a>
          </div>
        </section>

        <section style={{ marginTop: 56 }}>
          <div className="section-head"><h2>Open offers right now</h2><Link to="/lobby" className="link-gold">See all</Link></div>
          <div className="offer-scroller">
            {offers === null && <p className="muted">Loading offers…</p>}
            {offers?.map((o) => (
              <div className="card offer-card" key={o.id}>
                <div className="who">
                  <div className="avatar" aria-hidden="true">{o.owner[0].toUpperCase()}</div>
                  <div><Link to={`/p/${o.owner}`} className="strong">{o.owner}</Link><div className="muted small">Tic-tac-toe</div></div>
                </div>
                <div><div className="muted small">Pot</div><div className="pot-lg">{o.pot} tPOT</div></div>
                <div className="muted small">Each stakes {o.stake} tPOT</div>
                <Link to="/lobby" className="btn btn-ghost">Challenge</Link>
              </div>
            ))}
          </div>
        </section>

        <section id="how" style={{ marginTop: 48 }}>
          <div className="section-head"><h2>How a pot works</h2></div>
          <div className="grid-3">
            {STEPS.map((s, i) => (
              <div className="card" key={s.t}>
                <div className="step-no" aria-hidden="true">{i + 1}</div>
                <h2 className="h-sm">{s.t}</h2>
                <p className="muted small">{s.d}</p>
              </div>
            ))}
          </div>
        </section>

        <section style={{ marginTop: 48 }}>
          <div className="section-head"><h2>Games</h2></div>
          <div className="table" role="table" aria-label="Games">
            <div className="tr" role="row"><span role="columnheader">Game</span><span role="columnheader">Status</span><span role="columnheader">Format</span></div>
            {Object.values(GAMES).map((g) => (
              <div className="tr" role="row" key={g.id}>
                <strong role="cell">{g.title}</strong>
                <span role="cell"><span className={'badge ' + (g.available ? 'live' : 'soon')}>{g.available ? 'Live on testnet' : 'Coming next'}</span></span>
                <span role="cell" className="muted">{g.available ? 'Single game, winner takes the pot' : 'After the core mechanics are proven'}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
      <footer className="footer">Base Sepolia testnet. Test tokens only, no real money. Real-money play is off until it is cleared for specific jurisdictions.</footer>
    </>
  );
}
