import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { prefersReducedMotion } from '../lib/motion';

export interface TapButtonProps {
  state: 'countdown' | 'active' | 'ended';
  countdown?: number;
  onTap: () => void;
}

const PRESS_MS = 80;
const RELEASE_MS = 120;
const PRESS_SCALE = 0.97;
const VIBRATE_MS = 10;

export function TapButton({ state, countdown, onTap }: TapButtonProps) {
  const [pressed, setPressed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const press = () => {
    if (state !== 'active') return;
    onTap();
    if (prefersReducedMotion()) return;
    navigator.vibrate?.(VIBRATE_MS);
    setPressed(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPressed(false), PRESS_MS);
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button === 0) press();
  };

  // Keyboard activation; there is deliberately no onClick (a click would double-count a tap).
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!event.repeat) press();
  };

  const active = state === 'active';
  const look = active ? 'bg-purple text-on-purple' : 'bg-surface-sunken text-ink-muted';
  const monoClass = state === 'countdown' ? ' font-mono' : '';
  const label = active ? 'Attack' : state === 'countdown' ? `Duel starts in ${countdown ?? 0}` : undefined;

  return (
    <button
      type="button"
      disabled={!active}
      aria-label={label}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className={`display-tap min-h-[120px] w-full select-none rounded-tap ${look}${monoClass}`}
      style={{
        touchAction: 'manipulation',
        transform: pressed ? `scale(${PRESS_SCALE})` : 'none',
        transition: `transform ${pressed ? PRESS_MS : RELEASE_MS}ms ease-out`,
      }}
    >
      {state === 'active' ? 'TAP' : state === 'countdown' ? (countdown ?? 0) : 'Done'}
    </button>
  );
}
