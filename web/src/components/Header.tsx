import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useApp } from '../lib/context';

const P = {
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  crown: 'M4 18h16M5 18l-1-10 5 4 3-7 3 7 5-4-1 10',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  menu: 'M4 6h16M4 12h16M4 18h16',
};
const I = ({ d, s = 16 }: { d: string; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

export function Header({ onMenu }: { onMenu: () => void }) {
  const { client, account, refreshAccount } = useApp();
  const [busy, setBusy] = useState(false);
  const mint = async () => {
    setBusy(true);
    try { await client.mintTestTokens(); await refreshAccount(); } finally { setBusy(false); }
  };
  const bal = account ? account.balance.toFixed(2).split('.') : ['…', ''];
  return (
    <header className="topbar">
      <div className="tb-logo">
        <button className="tb-menu" onClick={onMenu} aria-label="Open menu"><I d={P.menu} s={20} /></button>
        <Link to="/" className="logo">PlayPot<span>.GG</span></Link>
      </div>
      <div className="tb-mid">
        <nav className="tb-tabs" aria-label="Games">
          <NavLink to="/lobby" className="tb-tab is-on"><I d={P.grid} />Tic-tac-toe</NavLink>
          <NavLink to="/lobby" className="tb-tab"><I d={P.crown} />Games</NavLink>
          <NavLink to="/match/demo" className="tb-tab"><I d={P.clock} />Challenges</NavLink>
        </nav>
        <div className="tb-right">
          <div className="tb-bal">
            <span className="tb-coin" aria-hidden="true" />
            <span className="tb-amt">{bal[0]}{bal[1] && <span>.{bal[1]}</span>} <small>tPOT</small></span>
            <button className="tb-glow" onClick={mint} disabled={busy}>{busy ? 'Adding…' : 'Deposit'}</button>
          </div>
          <button className="tb-soft">Withdraw</button>
          <button className="tb-soft tb-sq" aria-label="Settings"><I d={P.gear} s={20} /></button>
        </div>
      </div>
    </header>
  );
}
