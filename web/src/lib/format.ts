export const EXPLORER = 'https://testnet.monadscan.com';

const intFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Thousands-separated integer: 1950 -> "1,950". */
export function formatInt(n: number | bigint | string): string {
  if (typeof n === 'string') return intFormatter.format(BigInt(n));
  return intFormatter.format(n);
}

/** Latency in whole milliseconds, never seconds: "1,240 ms". */
export function formatMs(ms: number): string {
  return `${formatInt(Math.round(ms))} ms`;
}

/** Block number: "#73,562,481". */
export function formatBlock(n: number | bigint | string): string {
  return `#${formatInt(n)}`;
}

/** First 4 chars (incl. 0x) + ellipsis + last 2: "0xAb…12". */
export function shortHex(hex: string): string {
  if (hex.length <= 7) return hex;
  return `${hex.slice(0, 4)}…${hex.slice(-2)}`;
}

export const explorerTx = (hash: string): string => `${EXPLORER}/tx/${hash}`;

export const explorerAddress = (addr: string): string => `${EXPLORER}/address/${addr}`;

/** Win/loss record: "12 W · 4 L". */
export function formatRecord(wins: number, losses: number): string {
  return `${formatInt(wins)} W · ${formatInt(losses)} L`;
}
