const UNKNOWN_IP = 'unknown';

/**
 * Client IP for rate limiting. Production is nginx on a VPS without Cloudflare,
 * so `cf-connecting-ip` and the first `x-forwarded-for` entry are client-forgeable
 * and are NOT trusted. nginx sets `x-real-ip` and appends the real peer as the
 * LAST `x-forwarded-for` entry; the socket address is the final fallback.
 */
export function clientIp(headers: Headers, remoteAddr?: string): string {
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  if (forwarded) return forwarded;
  return remoteAddr?.trim() || UNKNOWN_IP;
}
