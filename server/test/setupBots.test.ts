import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TransactionReceiptNotFoundError, encodeFunctionData, formatEther, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { nadCardsAbi } from '@nad/shared';
import {
  ensureBots,
  loadBots,
  parseArgs,
  runSetup,
  runSweep,
  saveBots,
  topupNeeded,
  toReceiptOrNull,
  waitForReceipt,
  type Bot,
  type Receipt,
  type SetupDeps,
  type SetupOptions,
  type SweepDeps,
} from '../scripts/setup-bots';

// ------------------------------------------------------------------ fixtures

const KEYS: Hex[] = Array.from({ length: 12 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as Hex);
const keyAt = (i: number): Hex => KEYS[i]!;
const addressOf = (key: Hex): Hex => privateKeyToAccount(key).address;

const MASTER_KEY = keyAt(10);
const AGENT_KEY = keyAt(9);
const OPERATOR_ADDRESS = addressOf(keyAt(11));
const CARDS = '0x3333333333333333333333333333333333333333' as Hex;
const FREE_PULL_GAS = 250_000n;
const GAS_PRICE = 100_000_000_000n; // 100 gwei
const FREE_PULL_DATA = encodeFunctionData({ abi: nadCardsAbi, functionName: 'freePull' });
const MON = parseEther;

const botFor = (i: number, cardId: string | null = null): Bot => ({
  privateKey: keyAt(i),
  address: addressOf(keyAt(i)),
  cardId,
});

type SentTx = { from: Hex; to: Hex; data: Hex; gas: bigint; value: bigint; block: bigint };

type Rig = {
  deps: SetupDeps & SweepDeps;
  events: string[];
  sent: SentTx[];
  saved: Bot[][];
  balances: Map<string, bigint>;
  cards: Map<string, bigint>;
  pulled: Set<string>;
  logs: string[];
  failSendFor: Set<string>;
  clock: { block: bigint };
  fundingBlocks: Map<string, bigint>;
};

type RigOptions = {
  bots?: Bot[];
  balances?: Array<[Hex, bigint]>;
  cards?: Array<[Hex, bigint]>;
  pulled?: Hex[];
  masterBalance?: bigint;
  failSendFor?: Hex[];
  generated?: Hex[];
};

const lower = (a: string): string => a.toLowerCase();

function makeRig(options: RigOptions = {}): Rig {
  const clock = { block: 1000n };
  const events: string[] = [];
  const sent: SentTx[] = [];
  const saved: Bot[][] = [];
  const logs: string[] = [];
  const balances = new Map<string, bigint>();
  const cards = new Map<string, bigint>();
  const pulled = new Set<string>();
  const failSendFor = new Set((options.failSendFor ?? []).map(lower));
  const fundingBlocks = new Map<string, bigint>();
  const receipts = new Map<string, Receipt>();
  const generated = [...(options.generated ?? [])];
  let nextCard = 1n;
  let hashCounter = 0;
  let persisted: Bot[] = options.bots ? [...options.bots] : [];

  const masterAddress = addressOf(MASTER_KEY);
  balances.set(lower(masterAddress), options.masterBalance ?? MON('100'));
  for (const [address, wei] of options.balances ?? []) balances.set(lower(address), wei);
  for (const [address, id] of options.cards ?? []) cards.set(lower(address), id);
  for (const address of options.pulled ?? []) pulled.add(lower(address));

  function makeQueue(address: Hex, kind: 'master' | 'wallet') {
    return {
      address,
      async send(req: { to: Hex; data: Hex; gas: bigint; value?: bigint }): Promise<Hex> {
        if (failSendFor.has(lower(address))) throw new Error(`send rejected for ${address}`);
        const value = req.value ?? 0n;
        clock.block += 1n;
        events.push(`send:${kind}:${lower(address)}->${lower(req.to)}`);
        sent.push({ from: address, to: req.to, data: req.data, gas: req.gas, value, block: clock.block });
        balances.set(lower(address), (balances.get(lower(address)) ?? 0n) - value);
        balances.set(lower(req.to), (balances.get(lower(req.to)) ?? 0n) + value);
        if (value > 0n) fundingBlocks.set(lower(req.to), clock.block);
        if (req.data === FREE_PULL_DATA && lower(req.to) === lower(CARDS)) {
          pulled.add(lower(address));
          cards.set(lower(address), nextCard);
          nextCard += 1n;
        }
        hashCounter += 1;
        const hash = `0x${hashCounter.toString(16).padStart(64, '0')}` as Hex;
        receipts.set(hash, { status: 'success', blockNumber: clock.block });
        return hash;
      },
    };
  }

  const deps: SetupDeps & SweepDeps = {
    loadBots: () => persisted,
    saveBots: (bots) => {
      events.push('save');
      saved.push(bots);
      persisted = bots;
    },
    generateKey: () => {
      const next = generated.shift();
      if (!next) throw new Error('rig ran out of generated keys');
      return next;
    },
    agentKey: AGENT_KEY,
    operatorAddress: OPERATOR_ADDRESS,
    cards: CARDS,
    freePullGas: FREE_PULL_GAS,
    masterQueue: makeQueue(masterAddress, 'master'),
    queueFor: (key) => makeQueue(addressOf(key), 'wallet'),
    getBalance: async (address) => balances.get(lower(address)) ?? 0n,
    getBlockNumber: async () => clock.block,
    getGasPrice: async () => GAS_PRICE,
    cardOf: async (address) => cards.get(lower(address)) ?? 0n,
    hasPulled: async (address) => pulled.has(lower(address)),
    waitReceipt: async (hash) => {
      const receipt = receipts.get(hash);
      if (!receipt) throw new Error(`unknown tx ${hash}`);
      return receipt;
    },
    sleep: async () => {
      clock.block += 1n;
    },
    log: (line) => logs.push(line),
    masterAddress,
  };

  return { deps, events, sent, saved, balances, cards, pulled, logs, failSendFor, clock, fundingBlocks };
}

const SETUP: SetupOptions = { pairs: 1, topupMon: '0.15', dryRun: false };

// ------------------------------------------------------------------ parseArgs

describe('parseArgs', () => {
  test('accepts --pairs and --topup', () => {
    expect(parseArgs(['--pairs', '3', '--topup', '0.1'])).toEqual({
      mode: 'setup',
      pairs: 3,
      topupMon: '0.1',
      dryRun: false,
    });
  });

  test('defaults --topup to 0.15 MON', () => {
    expect(parseArgs(['--pairs', '2'])).toEqual({ mode: 'setup', pairs: 2, topupMon: '0.15', dryRun: false });
  });

  test('accepts --dry-run', () => {
    expect(parseArgs(['--pairs', '2', '--dry-run'])).toMatchObject({ mode: 'setup', dryRun: true });
  });

  test('accepts --sweep on its own', () => {
    expect(parseArgs(['--sweep'])).toEqual({ mode: 'sweep' });
  });

  test('rejects --sweep combined with setup flags so a dry run is never a real sweep', () => {
    expect(() => parseArgs(['--sweep', '--dry-run'])).toThrow(/--sweep/);
    expect(() => parseArgs(['--sweep', '--pairs', '2'])).toThrow(/--sweep/);
  });

  test('requires --pairs in setup mode', () => {
    expect(() => parseArgs([])).toThrow(/--pairs/);
    expect(() => parseArgs(['--topup', '0.1'])).toThrow(/--pairs/);
  });

  test.each([['0'], ['-1'], ['1.5'], ['abc'], ['51'], ['']])('rejects --pairs %j', (value) => {
    expect(() => parseArgs(['--pairs', value])).toThrow(/--pairs/);
  });

  test('rejects a --pairs flag with no value', () => {
    expect(() => parseArgs(['--pairs'])).toThrow(/--pairs/);
    expect(() => parseArgs(['--pairs', '--dry-run'])).toThrow(/--pairs/);
  });

  test.each([['0'], ['-0.1'], ['abc'], ['1e3'], ['']])('rejects --topup %j', (value) => {
    expect(() => parseArgs(['--pairs', '1', '--topup', value])).toThrow(/--topup/);
  });

  test('rejects unknown flags', () => {
    expect(() => parseArgs(['--pairs', '1', '--yolo'])).toThrow(/unknown argument/);
  });
});

// ---------------------------------------------------------------- topupNeeded

describe('topupNeeded', () => {
  test('sends only the difference', () => {
    expect(topupNeeded(MON('0.05'), MON('0.15'))).toBe(MON('0.1'));
  });

  test('sends nothing when the balance already meets the target', () => {
    expect(topupNeeded(MON('0.2'), MON('0.15'))).toBe(0n);
    expect(topupNeeded(MON('0.15'), MON('0.15'))).toBe(0n);
  });
});

// ----------------------------------------------------------------- ensureBots

describe('ensureBots', () => {
  test('keeps existing entries untouched and appends only the missing ones', () => {
    const existing = [botFor(0, '7'), botFor(1)];
    const generate = (() => {
      const queue = [keyAt(2), keyAt(3)];
      return () => queue.shift()!;
    })();
    const { bots, created } = ensureBots(existing, 4, generate);
    expect(created).toBe(2);
    expect(bots).toEqual([botFor(0, '7'), botFor(1), botFor(2), botFor(3)]);
    expect(existing).toHaveLength(2);
  });

  test('generates nothing when enough entries exist and keeps surplus entries', () => {
    const existing = [botFor(0), botFor(1), botFor(2)];
    const { bots, created } = ensureBots(existing, 2, () => {
      throw new Error('must not generate');
    });
    expect(created).toBe(0);
    expect(bots).toEqual(existing);
  });
});

// ------------------------------------------------------------------ bots file

describe('loadBots / saveBots', () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'setup-bots-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('a missing file loads as an empty list', () => {
    expect(loadBots(path.join(tmp(), 'bots.json'))).toEqual([]);
  });

  test('round-trips, creates the directory, and writes mode 0600', () => {
    const file = path.join(tmp(), 'nested', 'bots.json');
    saveBots(file, [botFor(0, '3'), botFor(1)]);
    expect(loadBots(file)).toEqual([botFor(0, '3'), botFor(1)]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('a corrupt file throws and is left untouched', () => {
    const file = path.join(tmp(), 'bots.json');
    writeFileSync(file, '{ not json');
    expect(() => loadBots(file)).toThrow(/bots\.json/);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  test('a file with the wrong shape throws', () => {
    const file = path.join(tmp(), 'bots.json');
    writeFileSync(file, JSON.stringify([{ address: '0x1' }]));
    expect(() => loadBots(file)).toThrow(/bots\.json/);
  });

  test('the written file never leaves a temp file behind', () => {
    const dir = tmp();
    saveBots(path.join(dir, 'bots.json'), [botFor(0)]);
    expect(JSON.parse(readFileSync(path.join(dir, 'bots.json'), 'utf8'))).toHaveLength(1);
    expect(() => statSync(path.join(dir, 'bots.json.tmp'))).toThrow();
  });
});

// ------------------------------------------------------------ waitForReceipt

describe('waitForReceipt', () => {
  const noSleep = async (): Promise<void> => {};

  test('treats a missing receipt as pending and returns the receipt once it appears', async () => {
    let calls = 0;
    const receipt: Receipt = { status: 'success', blockNumber: 5n };
    const result = await waitForReceipt(
      async () => (++calls < 3 ? null : receipt),
      '0xabc' as Hex,
      { sleep: noSleep, now: () => 0 },
    );
    expect(result).toEqual(receipt);
    expect(calls).toBe(3);
  });

  test('times out with the hash and explorer link', async () => {
    let now = 0;
    const promise = waitForReceipt(async () => null, '0xdeadbeef' as Hex, {
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    await expect(promise).rejects.toThrow(/0xdeadbeef.*testnet\.monadscan\.com\/tx\/0xdeadbeef/s);
  });
});

// ------------------------------------------------------------- toReceiptOrNull

describe('toReceiptOrNull', () => {
  test('maps viem TransactionReceiptNotFoundError to null (pending)', () => {
    const error = new TransactionReceiptNotFoundError({ hash: `0x${'ab'.repeat(32)}` });
    expect(toReceiptOrNull(error)).toBeNull();
  });

  test('rethrows unrelated errors unchanged', () => {
    const error = new Error('rpc exploded');
    expect(() => toReceiptOrNull(error)).toThrow(error);
    expect(() => toReceiptOrNull('not an error')).toThrow();
  });
});

// ------------------------------------------------------------------- runSetup

describe('runSetup', () => {
  test('writes freshly generated keys before sending any MON', async () => {
    const rig = makeRig({ bots: [], generated: [keyAt(0), keyAt(1)] });
    const result = await runSetup(rig.deps, SETUP);
    const firstSave = rig.events.indexOf('save');
    const firstSend = rig.events.findIndex((e) => e.startsWith('send:'));
    expect(firstSave).toBeGreaterThanOrEqual(0);
    expect(firstSend).toBeGreaterThan(firstSave);
    expect(rig.saved[0]).toEqual([botFor(0), botFor(1)]);
    expect(result.created).toBe(2);
  });

  test('tops up only the difference: bots, agent 1 MON, operator 0.5 MON', async () => {
    const bots = [botFor(0), botFor(1)];
    const rig = makeRig({
      bots,
      balances: [
        [bots[0]!.address, MON('0.05')],
        [bots[1]!.address, MON('0.2')],
        [addressOf(AGENT_KEY), MON('0.4')],
      ],
    });
    await runSetup(rig.deps, SETUP);
    const value = (to: Hex): bigint | undefined =>
      rig.sent.find((tx) => tx.from === rig.deps.masterAddress && lower(tx.to) === lower(to))?.value;
    expect(value(bots[0]!.address)).toBe(MON('0.1'));
    expect(value(bots[1]!.address)).toBeUndefined();
    expect(value(addressOf(AGENT_KEY))).toBe(MON('0.6'));
    expect(value(OPERATOR_ADDRESS)).toBe(MON('0.5'));
    const plain = rig.sent.find((tx) => tx.from === rig.deps.masterAddress)!;
    expect(plain.gas).toBe(21_000n);
    expect(plain.data).toBe('0x');
  });

  test('only processes the first 2N bots', async () => {
    const bots = [botFor(0), botFor(1), botFor(2), botFor(3)];
    const rig = makeRig({ bots });
    await runSetup(rig.deps, SETUP);
    const funded = rig.sent.filter((tx) => tx.value > 0n).map((tx) => lower(tx.to));
    expect(funded).toContain(lower(bots[0]!.address));
    expect(funded).toContain(lower(bots[1]!.address));
    expect(funded).not.toContain(lower(bots[2]!.address));
    // surplus entries are kept in the saved file
    expect(rig.saved.at(-1)).toHaveLength(4);
  });

  test('never sends freePull before block >= funding receipt block + 3', async () => {
    // Agent and operator are already funded and the agent owns a card, so ONLY the two bots are
    // funded (blocks 1001, 1002). Without the N9 wait, bot1 would pull at block 1004 < 1002 + 3.
    const bots = [botFor(0), botFor(1)];
    const rig = makeRig({
      bots,
      balances: [
        [addressOf(AGENT_KEY), MON('1')],
        [OPERATOR_ADDRESS, MON('0.5')],
      ],
      cards: [[addressOf(AGENT_KEY), 9n]],
      pulled: [addressOf(AGENT_KEY)],
    });
    await runSetup(rig.deps, SETUP);
    expect([...rig.fundingBlocks.values()]).toEqual([1001n, 1002n]);
    const pulls = rig.sent.filter((tx) => tx.data === FREE_PULL_DATA);
    expect(pulls).toHaveLength(2);
    for (const pull of pulls) {
      const funding = rig.fundingBlocks.get(lower(pull.from));
      expect(funding).toBeDefined();
      // the fake clock advances by one per send, so `block` is the block of this send
      expect(pull.block).toBeGreaterThanOrEqual(funding! + 3n);
    }
  });

  test('throws a clear error when the chain never reaches the N9 block', async () => {
    const rig = makeRig({ bots: [botFor(0), botFor(1)] });
    let now = 0;
    rig.deps.now = () => now;
    rig.deps.getBlockNumber = async () => 1000n; // stuck chain head
    rig.deps.sleep = async (ms) => {
      now += ms;
    };
    await expect(runSetup(rig.deps, SETUP)).rejects.toThrow(/block \d+ not reached after \d+s/);
    expect(rig.sent.some((tx) => tx.data === FREE_PULL_DATA)).toBe(false);
  });

  test('an error reading card state fails that wallet only; the rest are pulled and saved', async () => {
    const bots = [botFor(0), botFor(1)];
    const rig = makeRig({ bots });
    const cardOf = rig.deps.cardOf;
    rig.deps.cardOf = async (address) => {
      if (lower(address) === lower(bots[0]!.address) && rig.sent.every((tx) => tx.data !== FREE_PULL_DATA)) {
        throw new Error('rpc down');
      }
      return cardOf(address);
    };
    const result = await runSetup(rig.deps, SETUP);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(bots[0]!.address);
    const pullers = rig.sent.filter((tx) => tx.data === FREE_PULL_DATA).map((tx) => lower(tx.from));
    expect(pullers).toContain(lower(bots[1]!.address));
    expect(pullers).not.toContain(lower(bots[0]!.address));
    expect(rig.saved.at(-1)![1]!.cardId).not.toBeNull();
  });

  test('freePull is sent to the cards contract with the configured gas and no value', async () => {
    const rig = makeRig({ bots: [botFor(0), botFor(1)] });
    await runSetup(rig.deps, SETUP);
    const pull = rig.sent.find((tx) => tx.data === FREE_PULL_DATA)!;
    expect(lower(pull.to)).toBe(lower(CARDS));
    expect(pull.gas).toBe(FREE_PULL_GAS);
    expect(pull.value).toBe(0n);
  });

  test('stores the on-chain card id as a decimal string', async () => {
    const bots = [botFor(0), botFor(1)];
    const rig = makeRig({ bots });
    await runSetup(rig.deps, SETUP);
    const final = rig.saved.at(-1)!;
    expect(final.every((bot) => bot.cardId !== null && /^\d+$/.test(bot.cardId))).toBe(true);
    expect(rig.saved.length).toBeGreaterThanOrEqual(1);
  });

  test('agent pulls when cardOf is 0; operator is funded but never pulls', async () => {
    const rig = makeRig({ bots: [botFor(0), botFor(1)] });
    await runSetup(rig.deps, SETUP);
    const agentPulls = rig.sent.filter((tx) => tx.data === FREE_PULL_DATA && tx.from === addressOf(AGENT_KEY));
    const operatorSends = rig.sent.filter((tx) => tx.from === OPERATOR_ADDRESS);
    expect(agentPulls).toHaveLength(1);
    expect(operatorSends).toHaveLength(0);
    expect(rig.balances.get(lower(OPERATOR_ADDRESS))).toBe(MON('0.5'));
    expect(rig.balances.get(lower(addressOf(AGENT_KEY)))).toBe(MON('1'));
  });

  test('wallets that already hold a card are not pulled again and their id is recorded', async () => {
    const bots = [botFor(0), botFor(1)];
    const rig = makeRig({
      bots,
      cards: [
        [bots[0]!.address, 42n],
        [addressOf(AGENT_KEY), 9n],
      ],
      pulled: [bots[0]!.address, addressOf(AGENT_KEY)],
    });
    await runSetup(rig.deps, SETUP);
    const pullers = rig.sent.filter((tx) => tx.data === FREE_PULL_DATA).map((tx) => lower(tx.from));
    expect(pullers).toEqual([lower(bots[1]!.address)]);
    expect(rig.saved.at(-1)![0]!.cardId).toBe('42');
  });

  test('a used free pull without a card is skipped with a warning', async () => {
    const bots = [botFor(0), botFor(1)];
    const rig = makeRig({ bots, pulled: [bots[0]!.address] });
    const result = await runSetup(rig.deps, SETUP);
    const pullers = rig.sent.filter((tx) => tx.data === FREE_PULL_DATA).map((tx) => lower(tx.from));
    expect(pullers).not.toContain(lower(bots[0]!.address));
    expect(rig.logs.some((line) => /warning/i.test(line) && line.includes(bots[0]!.address))).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('pre-flight: insufficient master balance throws and sends nothing', async () => {
    const rig = makeRig({ bots: [botFor(0), botFor(1)], masterBalance: MON('1') });
    await expect(runSetup(rig.deps, SETUP)).rejects.toThrow(/master/i);
    expect(rig.sent).toHaveLength(0);
  });

  test('pre-flight accounts for gas on every transfer', async () => {
    // needs 0.15*2 + 1 + 0.5 = 1.8 MON of value, plus gas for 4 transfers
    const gas = 21_000n * 2n * GAS_PRICE * 4n;
    const exact = MON('1.8') + gas;
    const short = makeRig({ bots: [botFor(0), botFor(1)], masterBalance: exact - 1n });
    await expect(runSetup(short.deps, SETUP)).rejects.toThrow();
    const enough = makeRig({ bots: [botFor(0), botFor(1)], masterBalance: exact });
    await expect(runSetup(enough.deps, SETUP)).resolves.toMatchObject({ ok: true });
  });

  test('--dry-run prints the plan, sends nothing, and does not write the bots file', async () => {
    const rig = makeRig({ bots: [], generated: [keyAt(0), keyAt(1)] });
    const result = await runSetup(rig.deps, { ...SETUP, dryRun: true });
    expect(rig.sent).toHaveLength(0);
    expect(rig.saved).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, dryRun: true });
    const text = rig.logs.join('\n');
    expect(text).toContain(formatEther(MON('1.8')));
    expect(text).toContain(formatEther(MON('100')));
  });

  test('one failing pull does not stop the others and the result reports it', async () => {
    const bots = [botFor(0), botFor(1)];
    const rig = makeRig({ bots, failSendFor: [bots[0]!.address] });
    const result = await runSetup(rig.deps, SETUP);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(bots[0]!.address);
    const pullers = rig.sent.filter((tx) => tx.data === FREE_PULL_DATA).map((tx) => lower(tx.from));
    expect(pullers).toContain(lower(bots[1]!.address));
    expect(pullers).toContain(lower(addressOf(AGENT_KEY)));
    const final = rig.saved.at(-1)!;
    expect(final[0]!.cardId).toBeNull();
    expect(final[1]!.cardId).not.toBeNull();
  });

  test('a reverted free pull is reported as a failure', async () => {
    const bots = [botFor(0), botFor(1)];
    const rig = makeRig({ bots });
    const wait = rig.deps.waitReceipt;
    rig.deps.waitReceipt = async (hash) => {
      const receipt = await wait(hash);
      const tx = rig.sent[Number.parseInt(hash.slice(2), 16) - 1]!;
      return tx.data === FREE_PULL_DATA && tx.from === bots[0]!.address ? { ...receipt, status: 'reverted' } : receipt;
    };
    const result = await runSetup(rig.deps, SETUP);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
  });

  test('a failed funding transfer skips that wallet pull and is reported', async () => {
    const bots = [botFor(0), botFor(1)];
    const rig = makeRig({ bots });
    const send = rig.deps.masterQueue.send;
    rig.deps.masterQueue = {
      address: rig.deps.masterQueue.address,
      send: async (req) => {
        if (lower(req.to) === lower(bots[0]!.address)) throw new Error('boom');
        return send(req);
      },
    };
    const result = await runSetup(rig.deps, SETUP);
    expect(result.ok).toBe(false);
    const pullers = rig.sent.filter((tx) => tx.data === FREE_PULL_DATA).map((tx) => lower(tx.from));
    expect(pullers).not.toContain(lower(bots[0]!.address));
    expect(pullers).toContain(lower(bots[1]!.address));
  });

  test('never logs private keys', async () => {
    const rig = makeRig({ bots: [botFor(0), botFor(1)] });
    await runSetup(rig.deps, SETUP);
    const text = rig.logs.join('\n');
    for (const key of [...KEYS]) expect(text).not.toContain(key.slice(2));
  });
});

// ------------------------------------------------------------------- runSweep

describe('runSweep', () => {
  const FEE = 21_000n * GAS_PRICE * 2n;

  test('sends balance minus fee from each bot to the master and skips dust', async () => {
    const bots = [botFor(0), botFor(1), botFor(2)];
    const rig = makeRig({
      bots,
      balances: [
        [bots[0]!.address, MON('0.15')],
        [bots[1]!.address, FEE],
        [bots[2]!.address, FEE - 1n],
      ],
    });
    const result = await runSweep(rig.deps);
    expect(rig.sent).toHaveLength(1);
    const tx = rig.sent[0]!;
    expect(tx.from).toBe(bots[0]!.address);
    expect(lower(tx.to)).toBe(lower(rig.deps.masterAddress));
    expect(tx.value).toBe(MON('0.15') - FEE);
    expect(tx.gas).toBe(21_000n);
    expect(result).toMatchObject({ ok: true, totalReturnedWei: MON('0.15') - FEE, swept: 1 });
  });

  test('does not touch the agent or operator wallets', async () => {
    const rig = makeRig({
      bots: [botFor(0)],
      balances: [
        [botFor(0).address, MON('0.15')],
        [addressOf(AGENT_KEY), MON('1')],
        [OPERATOR_ADDRESS, MON('0.5')],
      ],
    });
    await runSweep(rig.deps);
    expect(rig.sent.map((tx) => tx.from)).toEqual([botFor(0).address]);
  });

  test('reports a failed sweep and continues with the rest', async () => {
    const bots = [botFor(0), botFor(1)];
    const rig = makeRig({
      bots,
      balances: [
        [bots[0]!.address, MON('0.15')],
        [bots[1]!.address, MON('0.15')],
      ],
      failSendFor: [bots[0]!.address],
    });
    const result = await runSweep(rig.deps);
    expect(result.ok).toBe(false);
    expect(result.swept).toBe(1);
    expect(result.failures).toHaveLength(1);
  });

  test('an empty bots file sweeps nothing', async () => {
    const rig = makeRig({ bots: [] });
    const result = await runSweep(rig.deps);
    expect(rig.sent).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, swept: 0, totalReturnedWei: 0n });
  });
});
