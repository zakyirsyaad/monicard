import { defineChain } from 'viem';

/**
 * Which Monad network this page talks to. Each host is served by its own game server:
 * monicard.xyz runs on mainnet, every other host (sslip mirror, localhost) on testnet.
 * The server's /config chainId always matches; this only picks the public RPC, explorer and labels.
 */
const MAINNET_HOSTS = ['monicard.xyz', 'www.monicard.xyz'];

const host = typeof location === 'undefined' ? '' : location.hostname;

export const IS_MAINNET = MAINNET_HOSTS.includes(host);

export const NETWORK = IS_MAINNET
  ? { id: 143, name: 'Monad Mainnet', label: 'Monad mainnet', rpc: 'https://rpc.monad.xyz', explorer: 'https://monadscan.com' }
  : {
      id: 10143,
      name: 'Monad Testnet',
      label: 'Monad testnet',
      rpc: 'https://testnet-rpc.monad.xyz',
      explorer: 'https://testnet.monadscan.com',
    };

export const monadChain = defineChain({
  id: NETWORK.id,
  name: NETWORK.name,
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [NETWORK.rpc] } },
});
