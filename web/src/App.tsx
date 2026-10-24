import { Route, Routes } from 'react-router-dom';
import { Arena } from './routes/Arena';
import { Dev } from './routes/Dev';
import { DuelRoute } from './routes/Duel';
import { Home } from './routes/Home';
import { Play } from './routes/Play';
import { Pull } from './routes/Pull';

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
      <Route path="/" element={<Home />} />
      <Route path="/pull" element={<Pull />} />
      <Route path="/play" element={<Play />} />
      <Route path="/duel/:id" element={<DuelRoute />} />
      <Route path="/arena" element={<Arena />} />
      <Route path="/dev" element={<Dev />} />
      <Route path="*" element={<Placeholder name="Not found" />} />
    </Routes>
  );
}
