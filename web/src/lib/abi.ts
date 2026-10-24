import { parseAbi } from 'viem';

// Single import point for contract ABIs: re-exports @nad/shared (generated from the contract build artifacts, `as const`).
// Never import `@nad/shared/bytecode` from web.
export { nadCardsAbi, blitzArenaAbi } from '@nad/shared';

// Local facade of contracts/src/StakeVault.sol. TODO: switch to the `stakeVaultAbi` export of @nad/shared once it exists.
export const stakeVaultAbi = parseAbi([
  'function stakes(uint256 duelId) view returns (uint128 amount, uint32 openedBlock, bool p1Staked, bool p2Staked, bool claimed)',
  'function stake(uint256 duelId) payable',
  'function claim(uint256 duelId)',
  'event Staked(uint256 indexed duelId, address indexed player, uint256 amount)',
  'event Claimed(uint256 indexed duelId, address indexed to, uint256 amount, uint256 rake)',
]);
