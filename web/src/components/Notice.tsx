import type { ReactNode } from 'react';

export interface NoticeProps {
  tone?: 'error' | 'info';
  children: ReactNode;
}

const LOOK = {
  error: 'bg-berry-tint text-berry',
  info: 'bg-purple-tint text-purple-ink',
} as const;

export function Notice({ tone = 'error', children }: NoticeProps) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`body rounded-card px-4 py-3 ${LOOK[tone]}`}>
      {children}
    </div>
  );
}
