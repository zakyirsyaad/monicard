import type { WebSocketLike } from '../lib/arenaState';

/** Minimal mock: opens and sends nothing. The full simulator lands in Task 11c-2. */
export function createMockSocket(_url: string): WebSocketLike {
  const socket: WebSocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close() {
      socket.onclose?.({});
    },
  };
  setTimeout(() => socket.onopen?.({}), 0);
  return socket;
}
