import { explorerTx, formatBlock, formatMs } from '../lib/format';

export interface LatencyBadgeProps {
  block: number | null;
  latencyMs: number | null;
  /** When given, the latency badge links to the tx on MonadScan (proof of a live onchain tx). */
  txHash?: string | null;
}

const FAST_MS = 1000;
const SLOW_MS = 2000;

function latencyColors(latencyMs: number | null): string {
  if (latencyMs === null) return 'bg-surface-sunken text-ink-muted';
  if (latencyMs < FAST_MS) return 'bg-purple-tint text-purple-ink';
  if (latencyMs <= SLOW_MS) return 'bg-surface-sunken text-ink';
  return 'bg-berry-tint text-berry';
}

export function LatencyBadge({ block, latencyMs, txHash }: LatencyBadgeProps) {
  const badgeClass = `data rounded-chip px-2 py-1 ${latencyColors(latencyMs)}`;
  const text = latencyMs === null ? '— ms' : formatMs(latencyMs);

  return (
    <div className="flex items-center gap-2">
      <span className="data text-ink-muted">{block === null ? '#—' : formatBlock(block)}</span>
      {txHash ? (
        <a
          href={explorerTx(txHash)}
          target="_blank"
          rel="noreferrer"
          aria-label={`${text}, view last transaction on MonadScan`}
          className={`${badgeClass} hover:underline`}
        >
          {text}
        </a>
      ) : (
        <span className={badgeClass}>{text}</span>
      )}
    </div>
  );
}
