import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { CardImage } from '../components/CardImage';
import { Notice } from '../components/Notice';
import { Screen } from '../components/Screen';
import { api } from '../lib/api';
import { CARD_IMAGE_SRC } from '../lib/cardImage';
import { friendlyError, toFriendly } from '../lib/errors';
import { pullCard, startDuel } from '../lib/flows';
import { formatMon, formatRecord } from '../lib/format';
import { RARITIES, RARITY_ODDS } from '../lib/game';
import { actionDeps, burnerAccount } from '../lib/player';
import type { NadgachaCard } from '../lib/types';
import { useConfig } from '../lib/useConfig';
import { useTxGap } from '../lib/useTxGap';

type Busy = 'agent' | 'friend' | 'pull' | null;

const ODDS_LINE = RARITIES.map((name, i) => `${name} ${RARITY_ODDS[i]}%`).join(' · ');
const CREATING = 'Creating duel…';

export function Play() {
  const navigate = useNavigate();
  const { config } = useConfig();
  const [card, setCard] = useState<NadgachaCard | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const { ready: gapOk, recheck } = useTxGap();
  // A duel we created whose challenge was refused: retries reuse it instead of creating another.
  const openDuel = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const account = await api.getAccount(burnerAccount().address);
      if (account.cardId === null) {
        if (!cancelled) navigate('/', { replace: true });
        return;
      }
      const meta = await api.getCard(account.cardId);
      if (cancelled) return;
      if (meta && 'nadgacha' in meta) setCard(meta.nadgacha);
      else setError("We couldn't load your card. Reload to try again.");
    };
    load().catch((err: unknown) => {
      if (!cancelled) setError(toFriendly(err, { fn: 'getAccount' }));
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const run = async (kind: Exclude<Busy, null>, fn: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(toFriendly(err, { fn }));
      setBusy(null);
    } finally {
      recheck();
    }
  };

  const duelId = async (cardId: string): Promise<string> => {
    if (!config) throw new Error('Config not loaded');
    openDuel.current ??= await startDuel(actionDeps(config), cardId);
    return openDuel.current;
  };

  const fightAgent = () =>
    run('agent', 'createDuel', async () => {
      if (!card) return;
      const id = await duelId(String(card.id));
      const res = await api.challengeAgent(id);
      if (res.ok) {
        navigate(`/duel/${id}`);
        return;
      }
      if (res.reason === 'not_open' || res.reason === 'stale') openDuel.current = null;
      setError(friendlyError({ kind: 'agent', reason: res.reason }));
      setBusy(null);
    });

  const challengeFriend = () =>
    run('friend', 'createDuel', async () => {
      if (!card) return;
      navigate(`/duel/${await duelId(String(card.id))}`);
    });

  const pullAgain = () =>
    run('pull', 'paidPull', async () => {
      if (!config) return;
      const tokenId = await pullCard(actionDeps(config), { paid: true });
      navigate(`/pull?card=${encodeURIComponent(tokenId)}`);
    });

  const price = config ? formatMon(config.pullPrice) : '0.05';
  const ready = card !== null && config !== null;
  const pullDisabled = !ready || !gapOk;

  return (
    <Screen>
      {config && <p className="label text-ink-muted">{config.event.name}</p>}
      {card ? (
        <section className="flex flex-col items-center gap-2 text-center">
          <div className="w-[200px]">
            <CardImage
              id={String(card.id)}
              name={card.nadmon.name}
              rarity={card.rarity}
              version={card.status}
              src={CARD_IMAGE_SRC}
            />
          </div>
          <h1 className="title">{card.nadmon.name}</h1>
          <p className="data text-ink-muted">{formatRecord(card.wins, card.losses)}</p>
        </section>
      ) : (
        <div className="mx-auto aspect-[300/560] w-[200px] rounded-card bg-surface-sunken" />
      )}
      <div className="mt-auto flex flex-col gap-3">
        {error && <Notice>{error}</Notice>}
        <Button busy={busy === 'agent'} busyLabel={CREATING} disabled={!ready || busy !== null} onClick={() => void fightAgent()}>
          Fight AI Agent
        </Button>
        <Button
          variant="secondary"
          busy={busy === 'friend'}
          busyLabel={CREATING}
          disabled={!ready || busy !== null}
          onClick={() => void challengeFriend()}
        >
          Challenge a friend
        </Button>
        <Button
          variant="secondary"
          busy={busy === 'pull'}
          busyLabel="Pulling…"
          disabled={pullDisabled || busy !== null}
          onClick={() => void pullAgain()}
        >
          Pull again · {price} MON
        </Button>
        <p className="data text-center text-ink-muted">{ODDS_LINE}</p>
      </div>
    </Screen>
  );
}
