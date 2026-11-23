import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useApp } from '../lib/context';

export function Header() {
  const { client, account, refreshAccount } = useApp();
  const [busy, setBusy] = useState(false);
  const mint = async () => {
    setBusy(true);
    try { await client.mintTestTokens(); await refreshAccount(); } finally { setBusy(false); }
  };
  return (
    <header className="header">
      <NavLink to="/" className="logo">PlayPot<span>.GG</span></NavLink>
      <nav className="nav">
        <NavLink to="/" end>Home</NavLink>
        <NavLink to="/lobby">Lobby</NavLink>
        <NavLink to="/p/you">My games</NavLink>
        <NavLink to="/match/demo">Matches</NavLink>
      </nav>
      <div className="header-right">
        <strong>{account ? `${account.balance} tPOT` : '…'}</strong>
        <button className="btn btn-ghost" onClick={mint} disabled={busy}>{busy ? 'Minting…' : 'Mint test tokens'}</button>
        <button className="btn btn-chip">{account?.short ?? 'Connect wallet'}</button>
      </div>
    </header>
  );
}
