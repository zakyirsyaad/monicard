import { useMemo } from 'react';
import { pickFeatured, swarmDuels } from '../lib/arenaView';
import { useArenaSocket } from '../lib/useArenaSocket';
import { useConfig } from '../lib/useConfig';
import { AgentPanel } from './arena/AgentPanel';
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
          <TxCounters stats={socket.stats} />
          {socket.leaderboard !== null && <Leaderboard entries={socket.leaderboard} />}
        </div>
      </div>
      <SwarmGrid duels={swarm} block={socket.block} />
    </main>
  );
}
