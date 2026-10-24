/** Mock mode has no card renderer: every card uses the placeholder. Real mode lets CardImage build the server URL. */
export const CARD_IMAGE_SRC: string | undefined =
  import.meta.env.VITE_USE_MOCK === '1' ? '/mock/card.svg' : undefined;

/** Cache-busting retry param for a failed card image load (attempt 0 keeps the url unchanged). */
export function withRetryParam(url: string, attempt: number): string {
  if (attempt <= 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}r=${attempt}`;
}
