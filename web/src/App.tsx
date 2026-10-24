import { Route, Routes } from 'react-router-dom';
import { Dev } from './routes/Dev';

function Placeholder({ name }: { name: string }) {
  return (
    <main className="min-h-screen bg-surface px-4 py-6 text-ink">
      <h1 className="display">{name}</h1>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Placeholder name="Home" />} />
      <Route path="/pull" element={<Placeholder name="Pull" />} />
      <Route path="/play" element={<Placeholder name="Play" />} />
      <Route path="/duel/:id" element={<Placeholder name="Duel" />} />
      <Route path="/arena" element={<Placeholder name="Arena" />} />
      <Route path="/dev" element={<Dev />} />
      <Route path="*" element={<Placeholder name="Not found" />} />
    </Routes>
  );
}
