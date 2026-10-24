import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/Button';
import { ScoreDots } from './cards';
import { explorerAddress, shortHex } from '../../lib/format';
import { isBattleMock } from '../../lib/battle/useMatch';
import { battleAddress } from '../../lib/battle/actions';
import { outcomeFor } from '../../lib/battle/rules';
import type { BattleSide, MatchView } from '../../lib/battle/types';
import type { Config } from '../../lib/types';

export type BattleResultProps = {
  match: MatchView;
  side: BattleSide | null;
  config: Config | null;
};

/** Final screen: one big word, the score, and the two ways forward. */
export function BattleResult({ match, side, config }: BattleResultProps) {
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
