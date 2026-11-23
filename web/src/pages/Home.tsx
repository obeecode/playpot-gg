import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/context';
import type { Offer } from '../lib/types';

const STEPS = [
  { t: 'Pick an offer', d: 'Every offer is already funded by the player who made it, so there is nobody to wait for.' },
  { t: 'Match the pot', d: 'One click locks your matching stake in escrow. You sign once, then your moves are silent.' },
  { t: 'Winner keeps it', d: 'The winner claims the pot. A draw refunds both stakes in full.' },
];

const CATS = [
  { k: 'a', t: 'TIC-TAC-TOE', s: 'Live on testnet', g: 'X', to: '/lobby' },
  { k: 'b', t: 'CHESS', s: 'Coming next', g: '\u265B', to: '/' },
  { k: 'c', t: 'OPEN OFFERS', s: 'Funded and waiting', g: '\u21C5', to: '/lobby' },
  { k: 'd', t: 'MY GAMES', s: 'Your offers and results', g: '\u2605', to: '/p/you' },
];

export function Home() {
  const { client } = useApp();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  useEffect(() => { void client.listOffers('tic-tac-toe').then(setOffers); }, [client]);

  return (
    <>
      <main className="page page-home">
        <section className="hero-card">
          <div className="hero-art" aria-hidden="true" />
          <div className="hero-board" aria-hidden="true">
            {['X','O','','','X','O','O','','X'].map((m, i) => <div key={i} data-m={m}>{m}</div>)}
          </div>
          <div className="hero-shade" aria-hidden="true" />
          <div className="hero-body">
            <span className="hero-badge"><span className="dot" aria-hidden="true" />Testnet live</span>
            <h1 className="hero-title">Challenge anyone. <span>Winner keeps</span> the pot.</h1>
            <p className="hero-text">Pick a funded offer, match the stake and play. One signature to start, then your moves are silent.</p>
            <div className="cta-row">
              <Link to="/lobby" className="btn btn-glow">Browse open offers</Link>
              <a href="#how" className="btn btn-ghost">How it works</a>
            </div>
          </div>
        </section>

        <section className="cat-row">
          {CATS.map((c) => (
            <Link key={c.t} to={c.to} className={'cat-tile cat-' + c.k}>
              <div><div className="cat-title">{c.t}</div><div className="cat-sub">{c.s}</div></div>
              <span className="cat-glyph" aria-hidden="true">{c.g}</span>
              <span className="cat-go" aria-hidden="true">&#8250;</span>
            </Link>
          ))}
        </section>

        <section style={{ marginTop: 40 }}>
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

      </main>
      <footer className="footer">Base Sepolia testnet. Test tokens only, no real money. Real-money play is off until it is cleared for specific jurisdictions.</footer>
    </>
  );
}
