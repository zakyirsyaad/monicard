import type { WebSocketLike } from '../lib/arenaState';
import type { WsMessage } from '../lib/types';
import { getMockChain } from './chain';
import type { MockChain } from './chain';

function scopeOf(url: string): string {
  try {
    return new URL(url, 'http://localhost').searchParams.get('scope') ?? 'all';
  } catch {
    return 'all';
  }
}

/** Socket-like stand-in for `/ws?scope=...` driven by the mock chain. Never sends `leaderboard`. */
export function createMockSocket(url: string, chain: MockChain = getMockChain()): WebSocketLike {
  const scope = scopeOf(url);
  let open = false;
  let closed = false;
  const unsubscribers: Array<() => void> = [];

  const socket: WebSocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close() {
      if (closed) return;
      closed = true;
      unsubscribers.forEach((off) => off());
      socket.onclose?.({});
    },
  };

  const send = (msg: WsMessage): void => {
    if (open && !closed) socket.onmessage?.({ data: JSON.stringify(msg) });
  };

  unsubscribers.push(
    chain.subscribe(() => {
      send(chain.duelsMsg(scope));
      send(chain.statsMsg());
    }),
    chain.subscribeAgent(() => send(chain.agentMsg())),
  );

  queueMicrotask(() => {
    if (closed) return;
    open = true;
    socket.onopen?.({});
    send(chain.duelsMsg(scope));
    send(chain.statsMsg());
    send(chain.agentMsg());
  });

  return socket;
}
