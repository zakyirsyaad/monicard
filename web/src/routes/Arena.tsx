import { useEffect, useMemo, useState } from 'react';
import { nextPeak, pickFeatured, swarmDuels } from '../lib/arenaView';
import { useArenaSocket } from '../lib/useArenaSocket';
import { useConfig } from '../lib/useConfig';
import { AgentPanel } from './arena/AgentPanel';
import { AudienceQr } from './arena/AudienceQr';
import { FeaturedDuel } from './arena/FeaturedDuel';
import { Header } from './arena/Header';
import { Leaderboard } from './arena/Leaderboard';
import { SwarmGrid } from './arena/SwarmGrid';
import { TxCounters } from './arena/TxCounters';
import { useDarkTheme } from './arena/useDarkTheme';

/** `/arena`: the projector screen. Dark theme, no "self" player, scope=all socket. */
export function Arena() {
  useDarkTheme();
  const { config } = useConfig();
  const socket = useArenaSocket('all');
  const duels = useMemo(() => [...socket.duels.values()], [socket.duels]);
  const [peak, setPeak] = useState(0);
  useEffect(() => {
    if (socket.stats) setPeak((prev) => nextPeak(prev, socket.stats?.txPerSec ?? 0));
  }, [socket.stats]);

  if (!config) {
    return (
      <main className="min-h-[100dvh] bg-surface p-8 text-ink">
        <p className="title text-ink-muted">Connecting…</p>
      </main>
    );
  }

  const featured = pickFeatured(duels, socket.featuredId, config.bots);
  const swarm = swarmDuels(duels, featured?.id ?? null, socket.block);

  return (
    <main className="flex min-h-[100dvh] flex-col gap-8 bg-surface p-8 text-ink">
      <Header config={config} stats={socket.stats} block={socket.block} connected={socket.connected} />
      <div className="grid grid-cols-3 gap-8">
        <div className="col-span-2">
          <FeaturedDuel duel={featured} config={config} block={socket.block} />
        </div>
        <div className="flex flex-col gap-8">
          <AgentPanel agent={socket.agent} />
          <AudienceQr />
          <TxCounters stats={socket.stats} peak={peak} />
          {socket.leaderboard !== null && <Leaderboard entries={socket.leaderboard} />}
        </div>
      </div>
      <SwarmGrid duels={swarm} block={socket.block} />
    </main>
  );
}
