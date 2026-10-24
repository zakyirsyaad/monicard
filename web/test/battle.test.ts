import { describe, expect, it } from 'vitest';
import { createBattleSim } from '../src/lib/battle/mock';
import {
  EMPTY_SLOT,
  MAX_DRAWS,
  boardCards,
  boardDamage,
  cardAt,
  damageBetween,
  emptyBoardSlot,
  frontCard,
  handCards,
  handOf,
  normalizeMatch,
  pileLeft,
  sideData,
  specialDamage,
  strikeDamage,
} from '../src/lib/battle/rules';
import { elementMult } from '../src/lib/game';

const P1 = '0xAbCd000000000000000000000000000000000001';
const P2 = '0xabcd000000000000000000000000000000000002';
const flat = (): number => 0.5;

function newMatch() {
  const sim = createBattleSim({ random: flat, autoAgent: false });
  const id = sim.createMatch(P1);
  sim.joinMatch(id, P2);
  return { sim, id };
}

describe('Card Battle v3 rules', () => {
  it('normalizes the ten-draw MatchView and keeps status/turn', () => {
    const match = normalizeMatch({
      id: 7n,
      p1: P1,
      p2: P2,
      status: 1,
      turn: 2,
      score1: 0,
      score2: 1,
      lastMoveBlock: 100,
      special1: false,
      special2: true,
      drawn1: 2,
      drawn2: 3,
      placed1: 1,
      placed2: 4,
      el1: [0, 1],
      rar1: [3],
      atk1: ['20'],
      maxHp1: [1800],
      hp1: [900],
      board1: [0],
      el2: [2],
      rar2: [1],
      atk2: [12],
      maxHp2: [1600],
      hp2: [1600],
      board2: [2, 1, EMPTY_SLOT],
    });

    expect(match).not.toBeNull();
    expect(match?.id).toBe('7');
    expect(match?.status).toBe('Active');
    expect(match?.turn).toBe(2);
    expect(match?.el1).toHaveLength(MAX_DRAWS);
    expect(match?.el1[1]).toBe(1);
    expect(match?.rar1[0]).toBe(3);
    expect(match?.atk1[0]).toBe(20);
    expect(match?.board1).toEqual([0, EMPTY_SLOT, EMPTY_SLOT]);
    expect(match?.board2).toEqual([2, 1, EMPTY_SLOT]);
    expect(normalizeMatch({})).toBeNull();
  });

  it('deals element-scaled strike and double special damage', () => {
    expect(elementMult(0, 2)).toBe(150);
    expect(elementMult(2, 2)).toBe(100);
    expect(elementMult(2, 0)).toBe(75);
    expect(strikeDamage(12, 0, 2)).toBe(630);
    expect(specialDamage(12, 0, 2)).toBe(1260);
  });

  it('reads hand, pile and board from draw numbers', () => {
    const { sim, id } = newMatch();
    const match = sim.getMatch(id);
    expect(match).not.toBeNull();
    if (match === null) return;

    expect(match.status).toBe('Active');
    expect(match.drawn1).toBe(1);
    expect(match.drawn2).toBe(1);
    expect(match.turn).toBe(2);

    const p1 = sideData(match, 1);
    expect(handOf(p1)).toEqual([0]);
    expect(pileLeft(p1)).toBe(9);
    expect(cardAt(p1, 0)).toMatchObject({ element: 1, rarity: 0, atk: 12, maxHp: 1650, hp: 1650 });
    expect(frontCard(p1)).toBeNull();
    expect(handCards(p1)).toHaveLength(1);
    expect(boardDamage(p1, 0)).toBe(0);
  });

  it('draws and places in one act, then attacks the front card', () => {
    const { sim, id } = newMatch();

    expect(sim.act(id, P2, 0, false)).toEqual({ ok: true });
    let match = sim.getMatch(id);
    expect(match).not.toBeNull();
    if (match === null) return;
    expect(match.drawn2).toBe(2);
    expect(match.board2[0]).toBe(0);
    expect(match.special2).toBe(false);
    expect(match.hp1[0]).toBe(1650);
    expect(match.turn).toBe(1);

    expect(sim.act(id, P1, 0, false)).toEqual({ ok: true });
    match = sim.getMatch(id);
    expect(match).not.toBeNull();
    if (match === null) return;
    expect(match.drawn1).toBe(2);
    expect(match.board1[0]).toBe(0);
    expect(match.hp2[0]).toBe(1230);
    expect(match.turn).toBe(2);
  });

  it('rejects an invalid hand index, a used special, and a full board', () => {
    const { sim, id } = newMatch();

    expect(sim.act(id, P1, 0, false)).toEqual({ ok: false, reason: 'not_your_turn' });
    expect(sim.act(id, P2, 5, false)).toEqual({ ok: false, reason: 'card_not_in_hand' });

    expect(sim.act(id, P2, 0, true)).toEqual({ ok: true });
    expect(sim.act(id, P1, 0, false)).toEqual({ ok: true });
    expect(sim.act(id, P2, 255, true)).toEqual({ ok: true });
    expect(sim.act(id, P1, 255, false)).toEqual({ ok: true });
    expect(sim.act(id, P2, 255, true)).toEqual({ ok: false, reason: 'special_used' });

    expect(sim.act(id, P2, 1, false)).toEqual({ ok: true });
    expect(sim.act(id, P1, 255, false)).toEqual({ ok: true });
    expect(sim.act(id, P2, 2, false)).toEqual({ ok: true });
    expect(sim.act(id, P1, 255, false)).toEqual({ ok: true });
    expect(sim.act(id, P2, 3, false)).toEqual({ ok: false, reason: 'board_full' });
  });

  it('does not spend Special when no attack can land', () => {
    const { sim, id } = newMatch();

    expect(sim.act(id, P2, 0, true)).toEqual({ ok: true });
    let match = sim.getMatch(id);
    expect(match).not.toBeNull();
    if (match === null) return;
    expect(match.special2).toBe(false);
    expect(match.turn).toBe(1);

    expect(sim.act(id, P1, 0, false)).toEqual({ ok: true });
    expect(sim.act(id, P2, 255, true)).toEqual({ ok: true });
    match = sim.getMatch(id);
    expect(match).not.toBeNull();
    if (match === null) return;
    expect(match.special2).toBe(true);
  });

  it('scores a KO, removes the front card and frees the slot', () => {
    const { sim, id } = newMatch();
    const moves: Array<[string, number]> = [
      [P2, 0],
      [P1, 0],
      [P2, 1],
      [P1, 1],
      [P2, 2],
    ];
    for (const [actor, handIdx] of moves) {
      expect(sim.act(id, actor, handIdx, false)).toEqual({ ok: true });
    }

    const match = sim.getMatch(id);
    expect(match).not.toBeNull();
    if (match === null) return;
    expect(match.score2).toBe(1);
    expect(match.hp1[0]).toBe(0);
    expect(match.board1[0]).toBe(EMPTY_SLOT);
    expect(emptyBoardSlot(sideData(match, 1))).toBe(0);
    expect(match.status).toBe('Active');
    expect(match.turn).toBe(1);
  });

  it('plays a full deterministic match to two KOs', () => {
    const { sim, id } = newMatch();
    let match = sim.getMatch(id);
    expect(match).not.toBeNull();
    if (match === null) return;

    for (let turn = 0; turn < 300 && match.status === 'Active'; turn += 1) {
      const side = match.turn === 1 ? 1 : 2;
      const actor = side === 1 ? P1 : P2;
      const player = sideData(match, side);
      const slot = emptyBoardSlot(player);
      const handIdx = slot === -1 ? 255 : (handCards(player)[0]?.drawNo ?? 255);
      const result = sim.act(id, actor, handIdx, false);
      expect(result.ok).toBe(true);
      match = sim.getMatch(id) as typeof match;
    }

    expect(['P1Won', 'P2Won']).toContain(match.status);
    expect(Math.max(match.score1, match.score2)).toBe(2);
  });

  it('shows the HP lost between two snapshots for the damage number', () => {
    const { sim, id } = newMatch();
    const before = sim.getMatch(id);
    expect(before).not.toBeNull();
    if (before === null) return;
    sim.act(id, P2, 0, false);
    sim.act(id, P1, 0, false);
    const after = sim.getMatch(id);
    expect(after).not.toBeNull();
    if (after === null) return;
    expect(damageBetween(before, after, 2)).toBe(420);
    expect(boardCards(sideData(after, 2))[0]?.drawNo).toBe(0);
  });
});
