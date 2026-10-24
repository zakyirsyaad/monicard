const UNKNOWN_IP = 'unknown';

/** Best-effort client IP behind Cloudflare Tunnel / reverse proxies. */
export function clientIp(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || UNKNOWN_IP;
}
