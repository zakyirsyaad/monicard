import type { Api, Config } from '../lib/types';

const MOCK_CONFIG: Config = {
  chainId: 10143,
  contracts: {
    cards: '0x00000000000000000000000000000000000000c1',
    arena: '0x00000000000000000000000000000000000000a1',
  },
  gasLimits: {
    freePull: 400000,
    paidPull: 400000,
    createDuel: 300000,
    joinDuel: 300000,
    attack: 120000,
    settle: 200000,
  },
  gasPrice: '100000000000',
  batchMs: 1000,
  pullPrice: '50000000000000000',
  event: { name: 'NadGacha BlitzArena', sponsor: null },
  agent: '0x00000000000000000000000000000000000000a9',
  bots: [
    '0x00000000000000000000000000000000000000b1',
    '0x00000000000000000000000000000000000000b2',
  ],
};

const notImplemented = (): never => {
  throw new Error('mock: not implemented yet');
};

/** Minimal stub. The full chain simulator lands in Task 11c-2. */
export const mockApi: Api = {
  getConfig: () => Promise.resolve(MOCK_CONFIG),
  getAccount: notImplemented,
  fund: notImplemented,
  relay: notImplemented,
  getCard: notImplemented,
  challengeAgent: notImplemented,
};
