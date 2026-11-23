import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useApp } from '../lib/context';

export function Header({ onMenu }: { onMenu: () => void }) {
  const { client, account, refreshAccount } = useApp();
  const [busy, setBusy] = useState(false);
  const mint = async () => {
    setBusy(true);
    try { await client.mintTestTokens(); await refreshAccount(); } finally { setBusy(false); }
  };
  return (
    <header className="header">
      <button className="btn btn-ghost menu-btn" onClick={onMenu} aria-label="Open menu">Menu</button>
      <NavLink to="/" className="logo header-logo">PlayPot<span>.GG</span></NavLink>
      <div className="header-right">
        <button className="btn btn-ghost" onClick={() => window.location.reload()} aria-label="Reload the app">Reload app</button>
        <strong>{account ? `${account.balance} tPOT` : '…'}</strong>
        <button className="btn btn-ghost" onClick={mint} disabled={busy}>{busy ? 'Minting…' : 'Mint test tokens'}</button>
        <button className="btn btn-chip">{account?.short ?? 'Connect wallet'}</button>
      </div>
    </header>
  );
}
