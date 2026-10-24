import { STAKE_OPTIONS, battleStakeAvailable, potLabel, stakeOptionLabel } from '../../lib/battle/stake';
import type { Config } from '../../lib/types';

export type StakeChipsProps = {
  config: Config | null;
  value: bigint;
  onChange: (wei: bigint) => void;
  disabled?: boolean;
};

/** Lobby "Stake" row: Free (default), 0.01, 0.05, 0.1 MON. Renders nothing when the vault is not configured. */
export function StakeChips({ config, value, onChange, disabled = false }: StakeChipsProps) {
  if (!battleStakeAvailable(config)) return null;
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Stake">
      <div className="flex items-baseline justify-between gap-3">
        <span className="label text-ink-muted">Stake</span>
        <span className="data text-ink-muted">{value > 0n ? potLabel(value) : 'No MON at stake'}</span>
      </div>
      <div className="flex gap-2">
        {STAKE_OPTIONS.map((wei) => (
          <button
            key={wei.toString()}
            type="button"
            aria-pressed={wei === value}
            disabled={disabled}
            onClick={() => onChange(wei)}
            className={`data min-h-[44px] flex-1 rounded-chip border px-1 [touch-action:manipulation] disabled:opacity-40 ${
              wei === value ? 'border-purple bg-purple-tint text-purple-ink' : 'border-line bg-surface-raised text-ink'
            }`}
          >
            {stakeOptionLabel(wei)}
          </button>
        ))}
      </div>
    </div>
  );
}
