import { formatEther } from 'viem';
import { formatBlock, formatInt } from '../../lib/format';
import { useArenaSocket } from '../../lib/useArenaSocket';
import './home.css';
import { NETWORK } from '../../lib/network';

/** Live proof strip. Each number appears only once the server has sent a non-zero value. */
export function LiveStrip() {
  const { stats, block } = useArenaSocket('all');
  const treasury = stats ? Number(formatEther(BigInt(stats.treasury))) : 0;
  const items = [
    block > 0 ? { k: 'Block', v: formatBlock(block) } : null,
    stats && stats.txTotal > 0 ? { k: 'Onchain tx', v: formatInt(stats.txTotal) } : null,
    treasury > 0 ? { k: 'Treasury', v: `${treasury.toFixed(2)} MON` } : null,
  ].filter((i): i is { k: string; v: string } => i !== null);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-card border border-line bg-surface-raised px-4 py-3">
      <span className="label flex items-center gap-2 text-ink">
        <span className="live-dot block h-2 w-2 rounded-full bg-purple" aria-hidden="true" />
        Live on {NETWORK.label}
      </span>
      {items.map((i) => (
        <span key={i.k} className="data text-ink-muted">
          {i.k} <span className="text-ink">{i.v}</span>
        </span>
      ))}
    </div>
  );
}
