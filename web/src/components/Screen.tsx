import type { ReactNode } from 'react';

/** Mobile column shared by the player screens. */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-[100dvh] bg-surface text-ink">
      <div className="mx-auto flex min-h-[100dvh] max-w-[420px] flex-col gap-6 px-4 py-6">{children}</div>
    </main>
  );
}
