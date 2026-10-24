import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { ScoreDots } from './cards';
import { explorerAddress, shortHex } from '../../lib/format';
import { isBattleMock } from '../../lib/battle/useMatch';
import { battleAddress } from '../../lib/battle/actions';
import { battleErrorText } from '../../lib/battle/errors';
import { outcomeFor } from '../../lib/battle/rules';
import { battleStakeOutcome, canClaim, claimBattleStake, monLabel, winnerPayoutWei } from '../../lib/battle/stake';
import type { BattleStakeState } from '../../lib/battle/useBattleStake';
import type { BattleSide, MatchView } from '../../lib/battle/types';
import type { Config } from '../../lib/types';

export type BattleResultProps = {
  match: MatchView;
  side: BattleSide | null;
  config: Config | null;
  /** Vault read of this match; null when staking is off. */
  stakeState?: BattleStakeState | null;
};

/** Stake outcome block: Claim for a winner (or a returned stake), "Lost 0.1 MON stake" for the loser. */
function StakeOutcomeBlock({ match, side, config, stakeState }: Required<BattleResultProps>) {
  const [claiming, setClaiming] = useState(false);
  // Set after our own claim lands: the vault read can lag a block, and a second claim would burn gas.
  const [claimedHere, setClaimedHere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stake = stakeState?.stake ?? null;
  const outcome = battleStakeOutcome(match, side, stake);
  if (stake === null || outcome === 'none') return null;

  const payout = outcome === 'win' ? winnerPayoutWei(stake.amount) : stake.amount;
  const claim = async () => {
    if (claiming || claimedHere || config === null) return;
    setClaiming(true);
    setError(null);
    try {
      await claimBattleStake(config, match.id);
      setClaimedHere(true);
      stakeState?.refresh();
    } catch (err) {
      setError(battleErrorText(err, { fn: 'battleClaim' }));
    } finally {
      setClaiming(false);
    }
  };

  if (outcome === 'lose') {
    return <p className="data text-berry">Lost {monLabel(stake.amount)} MON stake</p>;
  }
  return (
    <div className="flex w-full flex-col items-center gap-3">
      {stake.claimed || claimedHere ? (
        <p role="status" className="data text-purple-ink">
          {outcome === 'win' ? `Claimed ${monLabel(payout)} MON` : 'Stake returned'}
        </p>
      ) : (
        <>
          <p className="data text-ink-muted">
            {outcome === 'win' ? `You won ${monLabel(payout)} MON` : `Stake of ${monLabel(payout)} MON comes back`}
          </p>
          {canClaim(match, side, stake) && !claimedHere && (
            <Button busy={claiming} busyLabel="Claiming…" onClick={() => void claim()}>
              {outcome === 'win' ? 'Claim' : 'Claim stake back'}
            </Button>
          )}
        </>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

/** Final screen: one big word, the score, and the two ways forward. */
export function BattleResult({ match, side, config, stakeState = null }: BattleResultProps) {
  const navigate = useNavigate();
  const outcome = side === null ? null : outcomeFor(match, side);
  const winner = match.status === 'P1Won' ? match.p1 : match.status === 'P2Won' ? match.p2 : null;
  const headline = outcome ?? 'Match ended';
  const contract = config !== null && !isBattleMock() ? battleAddress(config) : null;
  const topLabel = side === null ? 'P1' : 'Opponent';
  const bottomLabel = side === null ? 'P2' : 'You';
  const topScore = side === null ? match.score1 : side === 1 ? match.score2 : match.score1;
  const bottomScore = side === null ? match.score2 : side === 1 ? match.score1 : match.score2;

  return (
    <main className="flex min-h-[100dvh] flex-col bg-surface text-ink">
      <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col gap-8 px-4 py-8">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="label text-ink-muted">Best of 3</p>
          <h1 className={`display-tap ${outcome === 'Victory' ? 'text-purple' : outcome === 'Defeat' ? 'text-berry' : 'text-ink'}`}>
            {headline}
          </h1>
          {outcome === null && winner !== null && (
            <p className="body text-ink-muted">
              {shortHex(winner)} wins the match
            </p>
          )}
          <div className="flex items-center gap-6 rounded-card border border-line bg-surface-raised px-6 py-4">
            <div className="flex flex-col items-center gap-1">
              <span className="label text-purple-ink">{bottomLabel}</span>
              <ScoreDots filled={bottomScore} side="self" />
              <span className="data text-ink">{bottomScore}</span>
            </div>
            <span className="data text-ink-muted">—</span>
            <div className="flex flex-col items-center gap-1">
              <span className="label text-berry">{topLabel}</span>
              <ScoreDots filled={topScore} side="opponent" />
              <span className="data text-ink">{topScore}</span>
            </div>
          </div>
          <p className="body max-w-[280px] text-ink-muted">
            Match cards are temporary. Your collection was never touched.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {stakeState !== null && (
            <StakeOutcomeBlock match={match} side={side} config={config} stakeState={stakeState} />
          )}
          <Button onClick={() => navigate('/battle')}>New match</Button>
          <Button variant="secondary" onClick={() => navigate('/play')}>
            Back to play
          </Button>
          {contract !== null && (
            <a
              href={explorerAddress(contract)}
              target="_blank"
              rel="noopener noreferrer"
              className="data text-center text-ink-muted underline underline-offset-4"
            >
              CardBattle on MonadScan
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
