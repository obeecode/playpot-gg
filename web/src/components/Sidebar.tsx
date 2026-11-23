import { useState } from 'react';
import { NavLink } from 'react-router-dom';

const ICONS: Record<string, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  play: 'M8 5v14l11-7z',
  tag: 'M3 12V4h8l10 10-8 8L3 12zM7.5 8.5h.01',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  chevron: 'M6 9l6 6 6-6',
  cross: 'M5 5l14 14M19 5L5 19',
  crown: 'M4 18h16M5 18l-1-10 5 4 3-7 3 7 5-4-1 10',
  arrow: 'M9 6l6 6-6 6',
};

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

function Group({ icon, label, defaultOpen = true, active = false, plain = false, children }: { icon: string; label: string; defaultOpen?: boolean; active?: boolean; plain?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sb-group">
      <button className={'sb-group-head' + (active ? ' is-active' : '')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sb-ico"><Icon name={icon} /></span>
        <span className="sb-label">{label}</span>
        <span className={'sb-chev' + (open ? ' is-open' : '')}><Icon name="chevron" size={16} /></span>
      </button>
      {open && <div className={'sb-list' + (plain ? ' is-plain' : '')}>{children}</div>}
    </div>
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      {open && <div className="sb-backdrop" onClick={onClose} aria-hidden="true" />}
      <aside className={'sidebar' + (open ? ' is-open' : '')} aria-label="Main navigation">
        <NavLink to="/" className="logo sb-logo" onClick={onClose}>PlayPot<span>.GG</span></NavLink>

        <div className="sb-tiles">
          <NavLink to="/lobby" className="sb-tile sb-tile-a" onClick={onClose}>
            <span className="sb-tile-ico"><Icon name="tag" size={26} /></span>
            <span className="sb-tile-label">Lobby</span>
            <span className="sb-tile-go"><Icon name="arrow" size={12} /></span>
          </NavLink>
        </div>

        <Group icon="grid" label="Game hub" active plain>
          <NavLink to="/" end className="sb-item" onClick={onClose}><Icon name="home" /><span>Home</span></NavLink>
          <NavLink to="/lobby" className="sb-item" onClick={onClose}><Icon name="tag" /><span>Open offers</span></NavLink>
          <NavLink to="/match/demo" className="sb-item" onClick={onClose}><Icon name="play" /><span>Live match</span></NavLink>
          <NavLink to="/p/you" className="sb-item" onClick={onClose}><Icon name="clock" /><span>Recent results</span></NavLink>
          <NavLink to="/p/you" className="sb-item" onClick={onClose}><Icon name="user" /><span>My games</span></NavLink>
        </Group>

        <Group icon="bolt" label="Popular games">
          <NavLink to="/lobby" className="sb-game" onClick={onClose}>
            <span className="sb-thumb"><Icon name="cross" size={20} /></span>
            <span className="sb-game-name">Tic-tac-toe</span>
            <span className="sb-badge">Live</span>
          </NavLink>
          <div className="sb-game is-off" aria-disabled="true">
            <span className="sb-thumb"><Icon name="crown" size={20} /></span>
            <span className="sb-game-name">Chess</span>
            <span className="sb-badge sb-badge-soon">Soon</span>
          </div>
        </Group>
      </aside>
    </>
  );
}
