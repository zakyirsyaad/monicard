// Facade for @nad/shared ABIs: web code imports contract ABIs only from here.
// Implements the frozen Task 4 signatures locally until it lands, then becomes a re-export.
import { parseAbi } from 'viem';

export const nadCardsAbi = parseAbi([
  'function freePull() returns (uint256)',
  'function paidPull() payable returns (uint256)',
  'function cardOf(address) view returns (uint256)',
  'event CardMinted(uint256 indexed tokenId, address indexed owner, uint8 rarity, uint8 element, uint16 atk, uint16 hp)',
]);

export const blitzArenaAbi = parseAbi([
  'function createDuel(uint256 cardId) returns (uint256)',
  'function joinDuel(uint256 id, uint256 cardId)',
  'function attack(uint256 id, uint16 taps, bool useSkill)',
  'function settle(uint256 id)',
  'event DuelCreated(uint256 indexed id, address indexed p1, uint256 card1)',
]);
