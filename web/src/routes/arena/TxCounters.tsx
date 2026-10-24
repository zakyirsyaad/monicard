import { formatInt, formatMs } from '../../lib/format';
import type { StatsMsg } from '../../lib/types';

export interface TxCountersProps {
  stats: StatsMsg | null;
  /** Highest tx/s seen since the page opened. */
  peak: number;
}

/** The measured numbers: total relayed tx, peak rate and average confirmation time. Zero values are left out. */
export function TxCounters({ stats, peak }: TxCountersProps) {
  const total = stats?.txTotal ?? 0;
  const avgMs = stats?.avgLatencyMs ?? 0;
  return (
    <section className="rounded-card border border-line bg-surface-raised p-6">
      <p className="label text-ink-muted">Total onchain tx</p>
      <p className="display-tap font-mono tabular-nums text-ink">{total > 0 ? formatInt(total) : '—'}</p>
      {(peak > 0 || avgMs > 0) && (
        <p className="data mt-3 flex flex-wrap gap-x-4 text-ink-muted">
          {peak > 0 && <span>Peak {peak.toFixed(1)} tx/s</span>}
          {avgMs > 0 && <span>Avg confirmation {formatMs(avgMs)}</span>}
        </p>
      )}
    </section>
  );
}
