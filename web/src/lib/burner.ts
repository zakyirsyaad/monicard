import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';

export const BURNER_KEY = 'nad.burner';

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

let cached: PrivateKeyAccount | null = null;

/** `globalThis.localStorage`, or null when the accessor itself throws (blocked site data). */
function safeLocalStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readKey(storage: KeyValueStorage | null): Hex | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(BURNER_KEY);
    return value !== null && PRIVATE_KEY_RE.test(value) ? (value as Hex) : null;
  } catch {
    return null;
  }
}

function writeKey(storage: KeyValueStorage | null, key: Hex): void {
  if (!storage) return;
  try {
    storage.setItem(BURNER_KEY, key);
  } catch {
    // Storage blocked: the key lives in the module cache for this session.
  }
}

/** Burner wallet persisted in localStorage (`nad.burner`); in-memory fallback if storage is unavailable. */
export function loadOrCreateBurner(
  storage: KeyValueStorage | null = safeLocalStorage(),
): PrivateKeyAccount {
  if (cached) return cached;
  let key = readKey(storage);
  if (!key) {
    key = generatePrivateKey();
    writeKey(storage, key);
  }
  cached = privateKeyToAccount(key);
  return cached;
}

/** Test helper: forget the memoized account. */
export function resetBurnerCache(): void {
  cached = null;
}
