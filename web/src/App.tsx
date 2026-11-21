import { Navigate, Route, Routes } from 'react-router-dom';
import { Header } from './components/Header';
import { Lobby } from './pages/Lobby';
import { Profile } from './pages/Profile';
import { Match } from './pages/Match';

export function App() {
  return (
    <>
      <div className="testnet-strip">Base Sepolia testnet. Test tokens only, no real money.</div>
      <Header />
      <Routes>
        <Route path="/" element={<Lobby />} />
        <Route path="/p/:handle" element={<Profile />} />
        <Route path="/match/:id" element={<Match />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
