import type { KeyboardEvent, PointerEvent } from 'react';
import { formatInt } from '../lib/format';

export interface SkillButtonProps {
  damage: number;
  used: boolean;
  disabled?: boolean;
  onUse: () => void;
}

export function SkillButton({ damage, used, disabled = false, onUse }: SkillButtonProps) {
  const inactive = used || disabled;

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (event.repeat || inactive) return;
    onUse();
  };

  return (
    <button
      type="button"
      disabled={inactive}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        if (event.button === 0 && !inactive) onUse();
      }}
      onKeyDown={handleKeyDown}
      className={`flex h-14 w-full select-none items-center justify-between rounded-card px-4 ${
        inactive ? 'bg-surface-sunken text-ink-muted' : 'bg-deep text-on-deep'
      }`}
      style={{ touchAction: 'manipulation' }}
    >
      <span className="title">{used ? 'Skill used' : 'Last stand'}</span>
      <span className="data-lg">{used ? '—' : `${formatInt(damage)} dmg`}</span>
    </button>
  );
}
