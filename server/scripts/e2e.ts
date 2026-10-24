import { blitzArenaAbi, decodeDuels, nadCardsAbi, type DuelStatus, type Hex } from '@nad/shared';
import { createPublicClient, encodeFunctionData, http, parseEther, type Account } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  anvilChain,
  anvilDeployer,
  createAnvilSender,
  deployGame,
  fundAccount,
  startAnvil,
  startMiner,
  type AnvilSender,
} from './anvil';
import { runDuelPair } from '../src/sim/duelLoop';
import type { SideState } from '../src/sim/types';

const PORT = 8546;
const BURNER_FUNDS = parseEther('1');
const MINE_INTERVAL_MS = 40;
const SETUP_MINE_MS = 20;
const BATCH_BLOCKS = 3;
const TAPS_PER_SEC = 7;
const SKILL_HP_PERCENT = 30;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** Setup txs are mined explicitly: keep mining single blocks until the pending send settles. */
async function mineUntilSettled<T>(promise: Promise<T>, mine: (n: number) => Promise<void>): Promise<T> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  promise.then(mark, mark);
  while (!settled) {
    await sleep(SETUP_MINE_MS);
    await mine(1);
  }
  return promise;
}

const useSkillBelowThreshold = (s: SideState): boolean =>
  !s.skillUsed && s.myHp * 100 <= SKILL_HP_PERCENT * s.myMaxHp;

async function run(): Promise<DuelStatus> {
  const anvil = await startAnvil(PORT);
  try {
    const client = createPublicClient({ chain: anvilChain, transport: http(anvil.rpcUrl), cacheTime: 0 });
    const { cards, arena } = await deployGame(anvil.rpcUrl, anvilDeployer(), anvil.mine);
    console.log(`deployed NadCards ${cards} BlitzArena ${arena}`);

    const burners: Account[] = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
    for (const b of burners) await fundAccount(anvil.rpcUrl, b.address, BURNER_FUNDS);

    const cardIds: bigint[] = [];
    const elements: number[] = [];
    for (const b of burners) {
      const setup = await createAnvilSender(anvil.rpcUrl, b, cards);
      const data = encodeFunctionData({ abi: nadCardsAbi, functionName: 'freePull' });
      const receipt = await mineUntilSettled(setup.send(data), anvil.mine);
      assert(receipt.status === 'success', 'freePull succeeded');
      const id = await client.readContract({ address: cards, abi: nadCardsAbi, functionName: 'cardOf', args: [b.address] });
      assert(id !== 0n, 'burner owns a card');
      const card = await client.readContract({ address: cards, abi: nadCardsAbi, functionName: 'cards', args: [id] });
      cardIds.push(id);
      elements.push(Number(card.element));
    }
    console.log(`cards ${cardIds.join(',')} elements ${elements.join(',')}`);

    const [s1, s2]: AnvilSender[] = await Promise.all(burners.map((b) => createAnvilSender(anvil.rpcUrl, b, arena)));
    const side = (sender: AnvilSender, i: number) => ({
      send: (data: Hex) => sender.send(data),
      cardId: cardIds[i]!,
      tapsPerSec: () => TAPS_PER_SEC,
      useSkill: useSkillBelowThreshold,
      element: elements[i]!,
    });

    const readDuel = async (id: bigint) => {
      const raw = await client.readContract({ address: arena, abi: blitzArenaAbi, functionName: 'getDuels', args: [id, 1n] });
      return decodeDuels(raw, id)[0] ?? null;
    };

    const miner = startMiner(anvil.mine, MINE_INTERVAL_MS);
    let result;
    try {
      result = await runDuelPair({
        p1: side(s1!, 0),
        p2: side(s2!, 1),
        readDuel,
        readBlock: () => client.getBlockNumber().then(Number),
        batchBlocks: BATCH_BLOCKS,
        pollMs: 20,
      });
    } finally {
      await miner.stop();
      const minerFailure = miner.failure();
      if (minerFailure) console.error('miner failed:', minerFailure);
    }
    assert(miner.failure() === null, 'miner ran without errors');
    console.log(`duel ${result.duelId} finished: ${result.status}`);

    const settleData = encodeFunctionData({ abi: blitzArenaAbi, functionName: 'settle', args: [result.duelId] });
    const settleReceipt = await mineUntilSettled(s1!.send(settleData), anvil.mine);
    assert(settleReceipt.status === 'success', 'settle succeeded');

    await verifyResults(client, cards, cardIds, result.status);
    const final = await readDuel(result.duelId);
    assert(final !== null, 'duel readable after settle');
    assert(
      final.hp1 < final.maxHp1 || final.hp2 < final.maxHp2,
      `at least one attack landed (hp ${final.hp1}/${final.maxHp1} vs ${final.hp2}/${final.maxHp2})`,
    );
    return result.status;
  } finally {
    anvil.stop();
  }
}

async function verifyResults(
  client: ReturnType<typeof createPublicClient>,
  cards: Hex,
  cardIds: bigint[],
  status: DuelStatus,
): Promise<void> {
  const records = await Promise.all(
    cardIds.map((id) => client.readContract({ address: cards, abi: nadCardsAbi, functionName: 'cards', args: [id] })),
  );
  const [c1, c2] = records;
  assert(c1 !== undefined && c2 !== undefined, 'both cards readable');
  const games = (c: { wins: number; losses: number }) => c.wins + c.losses;
  if (status === 'Draw') {
    assert(games(c1) === 0 && games(c2) === 0, 'draw records nothing');
    return;
  }
  assert(games(c1) === 1 && games(c2) === 1, 'each card has exactly one recorded game');
  const winner = status === 'P1Won' ? c1 : c2;
  assert(winner.wins === 1, 'winner card has one win');
}

run().then(
  (status) => {
    console.log(`E2E OK status=${status}`);
    process.exit(0);
  },
  (error: unknown) => {
    console.error('E2E FAILED:', error);
    process.exit(1);
  },
);
