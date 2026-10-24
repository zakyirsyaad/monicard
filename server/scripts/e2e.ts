import { battleAbi, blitzArenaAbi, decodeDuels, nadCardsAbi, type DuelStatus, type Hex } from '@nad/shared';
import { createPublicClient, encodeFunctionData, http, parseEther, type Account, type PublicClient } from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { decodeMatches } from '../src/battle';
import {
  ANVIL_MNEMONIC,
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
/** Anvil dev account 3 is the AI Agent in `pnpm local`. */
const AGENT_INDEX = 3;
const NO_PLACEMENT = 255;

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
    const { cards, arena, battle, stakeVault } = await deployGame(anvil.rpcUrl, anvilDeployer(), anvil.mine);
    console.log(`deployed NadCards ${cards} BlitzArena ${arena} CardBattle ${battle} StakeVault ${stakeVault}`);

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

    await runCardBattle(anvil.rpcUrl, client, battle, burners[0]!, anvil.mine);
    return result.status;
  } finally {
    anvil.stop();
  }
}

/** One card battle against the AI Agent wallet: p1 opens, the agent joins and takes one turn. */
async function runCardBattle(
  rpcUrl: string,
  client: PublicClient,
  battle: Hex,
  p1: Account,
  mine: (blocks: number) => Promise<void>,
): Promise<void> {
  const p1Sender = await createAnvilSender(rpcUrl, p1, battle);
  const created = await mineUntilSettled(
    p1Sender.send(encodeFunctionData({ abi: battleAbi, functionName: 'createMatch' })),
    mine,
  );
  assert(created.status === 'success', 'createMatch succeeded');

  const id = await client.readContract({ address: battle, abi: battleAbi, functionName: 'matchCount' });
  const readMatch = async () => {
    const raw = await client.readContract({ address: battle, abi: battleAbi, functionName: 'getMatch', args: [id] });
    return decodeMatches([raw], id)[0]!;
  };
  assert((await readMatch()).status === 'Open', 'match is open after createMatch');

  const agent = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: AGENT_INDEX });
  await fundAccount(rpcUrl, agent.address, BURNER_FUNDS);
  const agentSender = await createAnvilSender(rpcUrl, agent, battle);
  const joined = await mineUntilSettled(
    agentSender.send(encodeFunctionData({ abi: battleAbi, functionName: 'joinMatch', args: [id] })),
    mine,
  );
  assert(joined.status === 'success', 'agent joinMatch succeeded');

  let match = await readMatch();
  assert(match.status === 'Active', 'match is active once the agent joins');
  if (match.turn === 1) {
    const passed = await mineUntilSettled(
      p1Sender.send(encodeFunctionData({ abi: battleAbi, functionName: 'act', args: [id, NO_PLACEMENT, false] })),
      mine,
    );
    assert(passed.status === 'success', 'p1 passed the turn');
    match = await readMatch();
  }
  assert(match.turn === 2, 'the agent holds the turn');

  const acted = await mineUntilSettled(
    agentSender.send(encodeFunctionData({ abi: battleAbi, functionName: 'act', args: [id, 0, false] })),
    mine,
  );
  assert(acted.status === 'success', 'agent act succeeded');
  const after = await readMatch();
  assert(after.turn === 1 || after.status !== 'Active', 'the agent finished its turn');
  console.log(`Card Battle ${id}: agent joined and acted (turn ${after.turn}, status ${after.status})`);
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
