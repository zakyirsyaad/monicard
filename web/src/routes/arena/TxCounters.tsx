import { formatInt, formatMs } from '../../lib/format';
import type { StatsMsg } from '../../lib/types';

export function TxCounters({ stats }: { stats: StatsMsg | null }) {
  return (
    <section className="rounded-card border border-line bg-surface-raised p-6">
      <p className="label text-ink-muted">Onchain tx</p>
      <p className="data-lg text-6xl leading-none text-ink">{stats ? formatInt(stats.txTotal) : '—'}</p>
      {stats && (
        <p className="data mt-3 text-ink-muted">
          {stats.txPerSec.toFixed(1)} tx/s · Avg latency {formatMs(stats.avgLatencyMs)}
        </p>
      )}
    </section>
  );
}
