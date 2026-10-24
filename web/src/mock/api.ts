import type { Hex } from 'viem';
import type { Api } from '../lib/types';
import { getMockChain } from './chain';
import type { MockChain } from './chain';

/** Mock `Api` over a chain simulator. The getter keeps the singleton lazy (and cycle-safe). */
export function createMockApi(chain: () => MockChain): Api {
  return {
    getConfig: () => Promise.resolve(chain().config),
    getAccount: (address: Hex) => Promise.resolve(chain().getAccount(address)),
    fund: (address: Hex) => Promise.resolve(chain().fund(address)),
    relay: (rawTx: Hex) => chain().relay(rawTx),
    getCard: (id: string) => Promise.resolve(chain().getCard(id)),
    challengeAgent: (duelId: string) => Promise.resolve(chain().challengeAgent(duelId)),
  };
}

export const mockApi: Api = /* @__PURE__ */ createMockApi(getMockChain);
