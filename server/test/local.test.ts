import { readFileSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import { ANVIL_MNEMONIC } from '../scripts/anvil';
import {
  bannerLines,
  buildServerEnv,
  checkNodeVersion,
  compareDeployment,
  deriveLocalKeys,
  lanAddress,
  shieldFromDotenv,
  stripOwnPrefix,
} from '../scripts/local';

const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DATA_DIR = '/repo/data/local';

const privateKeyOf = (index: number) => {
  const raw = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey;
  if (!raw) throw new Error('no key');
  return `0x${Buffer.from(raw).toString('hex')}`;
};

describe('deriveLocalKeys', () => {
  test('derives master, operator and agent from anvil mnemonic accounts 1 to 3', () => {
    const keys = deriveLocalKeys();

    expect(keys.master).toBe(privateKeyOf(1));
    expect(keys.operator).toBe(privateKeyOf(2));
    expect(keys.agent).toBe(privateKeyOf(3));
  });
});

describe('buildServerEnv', () => {
  const keys = deriveLocalKeys();

  test('sets every variable the local server needs', () => {
    const env = buildServerEnv({}, keys, DATA_DIR);

    expect(env).toMatchObject({
      DEPLOYMENT: 'anvil',
      PORT: '8080',
      RPC_URLS: 'http://127.0.0.1:8545',
      MASTER_KEY: keys.master,
      OPERATOR_KEY: keys.operator,
      AGENT_KEY: keys.agent,
      ADMIN_TOKEN: 'local-dev',
      FUND_ENABLED: 'true',
      FUND_BUDGET_MON: '1000',
      DATA_DIR,
      PUBLIC_URL: 'http://localhost:5173',
      EVENT_NAME: 'Monicard (local)',
    });
  });

  test('overrides conflicting values from the user environment', () => {
    const env = buildServerEnv({ PORT: '9999', DEPLOYMENT: 'mainnet', MASTER_KEY: '0xabc' }, keys, DATA_DIR);

    expect(env.PORT).toBe('8080');
    expect(env.DEPLOYMENT).toBe('anvil');
    expect(env.MASTER_KEY).toBe(keys.master);
  });

  test('drops LLM_* and MAINNET_* variables but keeps unrelated ones', () => {
    const base = {
      LLM_API_KEY: 'secret',
      LLM_BASE_URL: 'https://llm.example',
      LLM_MODEL: 'm',
      MAINNET_RPC_URL: 'https://mainnet.example',
      MAINNET_DEPLOYER_KEY: privateKeyOf(9),
      PATH: '/usr/bin',
      HOME: '/home/judge',
    };

    const env = buildServerEnv(base, keys, DATA_DIR);

    expect(Object.keys(env).filter((name) => /^(LLM_|MAINNET_)/.test(name))).toEqual([]);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/judge');
  });

  test('never contains a private key that is not derived from the mnemonic', () => {
    const stray = privateKeyOf(9);
    const env = buildServerEnv({ SOME_KEY: stray, MAINNET_DEPLOYER_KEY: stray }, keys, DATA_DIR);
    const derived = new Set([keys.master, keys.operator, keys.agent]);
    const keyLike = Object.values(env).filter((value) => value !== undefined && KEY_PATTERN.test(value));

    // A stray key in an unrelated variable is the user's own business; the ones we set must be derived.
    expect(env.MASTER_KEY && derived.has(env.MASTER_KEY as `0x${string}`)).toBe(true);
    expect(env.OPERATOR_KEY && derived.has(env.OPERATOR_KEY as `0x${string}`)).toBe(true);
    expect(env.AGENT_KEY && derived.has(env.AGENT_KEY as `0x${string}`)).toBe(true);
    expect(keyLike).not.toContain(env.MAINNET_DEPLOYER_KEY);
    expect(env.MAINNET_DEPLOYER_KEY).toBeUndefined();
  });

  test('does not mutate the base environment', () => {
    const base = { LLM_API_KEY: 'secret' };

    buildServerEnv(base, keys, DATA_DIR);

    expect(base).toEqual({ LLM_API_KEY: 'secret' });
  });
});

describe('shieldFromDotenv', () => {
  test('blanks the secret variables so a user .env cannot re-add them', () => {
    const shielded = shieldFromDotenv({ PATH: '/usr/bin' });

    expect(shielded.LLM_API_KEY).toBe('');
    expect(shielded.MAINNET_DEPLOYER_KEY).toBe('');
    expect(shielded.PATH).toBe('/usr/bin');
  });
});

describe('lanAddress', () => {
  const entry = (address: string, family: 'IPv4' | 'IPv6', internal: boolean): NetworkInterfaceInfo =>
    ({
      address,
      netmask: '255.255.255.0',
      family,
      mac: '00:00:00:00:00:00',
      internal,
      cidr: null,
    }) as NetworkInterfaceInfo;

  test('picks the first external IPv4 address', () => {
    const interfaces = {
      lo0: [entry('127.0.0.1', 'IPv4', true)],
      en0: [entry('fe80::1', 'IPv6', false), entry('192.168.1.23', 'IPv4', false)],
      en1: [entry('10.0.0.5', 'IPv4', false)],
    };

    expect(lanAddress(interfaces)).toBe('192.168.1.23');
  });

  test('returns null when there is no external IPv4 address', () => {
    const interfaces = {
      lo0: [entry('127.0.0.1', 'IPv4', true)],
      en0: [entry('fe80::1', 'IPv6', false)],
      empty: undefined,
    };

    expect(lanAddress(interfaces)).toBeNull();
    expect(lanAddress({})).toBeNull();
  });
});

describe('checkNodeVersion', () => {
  test('accepts Node 20 and newer', () => {
    expect(checkNodeVersion('v20.0.0')).toBeNull();
    expect(checkNodeVersion('22.23.4')).toBeNull();
  });

  test('rejects older Node with an upgrade hint', () => {
    expect(checkNodeVersion('v18.19.0')).toMatch(/Node 20 or newer/);
  });

  test('rejects an unparsable version', () => {
    expect(checkNodeVersion('banana')).toMatch(/Node 20 or newer/);
  });
});

describe('bannerLines', () => {
  const base = {
    webPort: 5173,
    lan: '192.168.1.23',
    cards: '0xCards',
    arena: '0xArena',
    battle: '0xBattle',
    stakeVault: '0xVault',
    agentCardId: 7n,
  };

  test('prints the open instructions, contracts, chain note and stop hint', () => {
    const text = bannerLines(base).join('\n');

    expect(text).toContain(
      'Monicard is running locally. Open http://localhost:5173 on this computer (or http://192.168.1.23:5173 on your phone, same Wi-Fi).',
    );
    expect(text).toContain('0xCards');
    expect(text).toContain('0xArena');
    expect(text).toContain('CardBattle');
    expect(text).toContain('0xBattle');
    expect(text).toContain('StakeVault');
    expect(text).toContain('0xVault');
    expect(text).toContain('Chain: local anvil (id 10143), 0.3 s blocks. No real MON is used.');
    expect(text).toContain('Ctrl+C');
  });

  test('omits the phone hint without a LAN address', () => {
    const text = bannerLines({ ...base, lan: null }).join('\n');

    expect(text).toContain('Open http://localhost:5173 on this computer.');
    expect(text).not.toContain('phone');
  });
});

describe('stripOwnPrefix', () => {
  test('removes the prefix the child adds itself', () => {
    expect(stripOwnPrefix('[server] Monicard API on port 8080', 'server')).toBe('Monicard API on port 8080');
  });

  test('leaves other lines untouched', () => {
    expect(stripOwnPrefix('VITE ready', 'web')).toBe('VITE ready');
    expect(stripOwnPrefix('[web] x', 'server')).toBe('[web] x');
  });
});

describe('compareDeployment', () => {
  const expected = {
    cards: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
    arena: '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb',
    battle: '0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc',
    stakeVault: '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd',
  };

  test('accepts the same addresses regardless of letter case', () => {
    expect(compareDeployment(expected, { ...expected, cards: expected.cards.toLowerCase() })).toEqual([]);
  });

  test('names every contract that drifted', () => {
    expect(
      compareDeployment(expected, {
        ...expected,
        battle: '0x0000000000000000000000000000000000000001',
        stakeVault: '0x0000000000000000000000000000000000000002',
      }),
    ).toEqual(['battle', 'stakeVault']);
  });
});

describe('deployments/anvil.json', () => {
  const deployment = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../deployments/anvil.json', import.meta.url)), 'utf8'),
  ) as {
    battle?: string;
    stakeVault?: string;
    gasLimits?: Record<string, number>;
  };

  test('carries the Card Battle and StakeVault addresses', () => {
    expect(deployment.battle).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(deployment.stakeVault).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test('carries a gas limit for every battle and stake function', () => {
    for (const fn of ['createMatch', 'joinMatch', 'act', 'claimTimeout', 'stake', 'claim']) {
      expect(deployment.gasLimits?.[fn], fn).toBeGreaterThan(0);
    }
  });
});
