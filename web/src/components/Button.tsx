import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: 'primary' | 'secondary';
  /** Shown instead of the children while busy; the button is disabled. */
  busyLabel?: string;
  busy?: boolean;
}

const LOOK = {
  primary: 'h-14 bg-purple text-on-purple title',
  secondary: 'h-12 border border-line bg-surface-raised text-ink title',
} as const;

export function Button({ variant = 'primary', busy = false, busyLabel, disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy}
      className={`w-full rounded-card px-4 [touch-action:manipulation] disabled:opacity-40 ${LOOK[variant]}`}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}
