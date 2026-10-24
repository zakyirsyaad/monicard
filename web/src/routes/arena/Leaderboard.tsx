import { formatRecord, shortHex } from '../../lib/format';
import type { LeaderboardEntry } from '../../lib/types';

const TOP = 10;

export function Leaderboard({ entries }: { entries: readonly LeaderboardEntry[] }) {
  return (
    <section className="rounded-card border border-line bg-surface-raised p-6">
      <h2 className="title text-ink">Leaderboard</h2>
      <ol className="mt-3 flex flex-col divide-y divide-line">
        {entries.slice(0, TOP).map((entry) => (
          <li key={entry.address} className="flex items-baseline justify-between gap-4 py-2">
            <span className="body min-w-0 truncate text-ink">{entry.label ?? shortHex(entry.address)}</span>
            <span className="data shrink-0 text-ink-muted">{formatRecord(entry.wins, entry.losses)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
