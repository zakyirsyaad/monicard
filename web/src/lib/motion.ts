/** True when the user asked the OS/browser to reduce motion. Read at call time, not cached. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
