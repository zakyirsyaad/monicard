import { formatEther } from 'viem';
import { NETWORK } from './network';

export const EXPLORER = NETWORK.explorer;

const intFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const INTEGER_STRING = /^-?\d+$/;

/** Thousands-separated integer: 1950 -> "1,950". */
export function formatInt(n: number | bigint | string): string {
  if (typeof n === 'string') return INTEGER_STRING.test(n) ? intFormatter.format(BigInt(n)) : n;
  if (typeof n === 'number' && Number.isNaN(n)) return '—';
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

/** MON amount without trailing zeros: 50000000000000000 wei -> "0.05". */
export function formatMon(wei: string | bigint): string {
  return Number(formatEther(BigInt(wei))).toString();
}
