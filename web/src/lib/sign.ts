import { parseGwei } from 'viem';
import type { Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Config } from './types';

export type SignCallParams = {
  to: Hex;
  data: Hex;
  nonce: number;
  gas: number;
  value?: bigint;
};

const PRIORITY_FEE = parseGwei('2');

/** Signs an EIP-1559 tx locally: maxFee = 2 × gasPrice, priority fee = 2 gwei, gas from /config. */
export function signCall(
  account: PrivateKeyAccount,
  config: Pick<Config, 'chainId' | 'gasPrice'>,
  { to, data, nonce, gas, value = 0n }: SignCallParams,
): Promise<Hex> {
  return account.signTransaction({
    type: 'eip1559',
    chainId: config.chainId,
    to,
    data,
    nonce,
    gas: BigInt(gas),
    value,
    maxFeePerGas: 2n * BigInt(config.gasPrice),
    maxPriorityFeePerGas: PRIORITY_FEE,
  });
}
