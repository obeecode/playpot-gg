import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Home } from './pages/Home';
import { Lobby } from './pages/Lobby';
import { Profile } from './pages/Profile';
import { Match } from './pages/Match';

export function App() {
  const [menu, setMenu] = useState(false);
  return (
    <div className="app">
      <Header onMenu={() => setMenu(true)} />
      <div className="shell">
      <Sidebar open={menu} onClose={() => setMenu(false)} />
      <div className="shell-main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/lobby" element={<Lobby />} />
          <Route path="/p/:handle" element={<Profile />} />
          <Route path="/match/:id" element={<Match />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      </div>
    </div>
  );
}
