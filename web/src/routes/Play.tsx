import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import type { Config } from '../lib/types';
import { useCardMeta } from '../lib/useCardMeta';
import { useConfig } from '../lib/useConfig';
import { useTxGap } from '../lib/useTxGap';

type Busy = 'agent' | 'friend' | 'pull' | null;

const ODDS_LINE = RARITIES.map((name, i) => `${name} ${RARITY_ODDS[i]}%`).join(' · ');
const CREATING = 'Creating duel…';

export function Play() {
  const navigate = useNavigate();
  const { config } = useConfig();
  const [cardId, setCardId] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const { reveal, error: cardError } = useCardMeta(cardId);
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { ready: gapOk, recheck } = useTxGap();
  // A duel we created whose challenge was refused: retries reuse it instead of creating another.
  const openDuel = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getAccount(burnerAccount().address).then(
      (account) => {
        if (cancelled) return;
        if (account.cardId === null) navigate('/', { replace: true });
        else setCardId(account.cardId);
      },
      (err: unknown) => {
        if (!cancelled) setAccountError(toFriendly(err, { fn: 'getAccount' }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const card = reveal?.card ?? null;
  const error = actionError ?? accountError ?? cardError;

  const run = async (kind: Exclude<Busy, null>, fn: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(toFriendly(err, { fn }));
      setBusy(null);
    } finally {
      recheck();
    }
  };

  const duelId = async (cfg: Config, id: string): Promise<string> => {
    openDuel.current ??= await startDuel(actionDeps(cfg), id);
    return openDuel.current;
  };

  const fightAgent = () => {
    if (cardId === null || !config) return Promise.resolve();
    return run('agent', 'createDuel', async () => {
      const id = await duelId(config, cardId);
      const res = await api.challengeAgent(id);
      if (res.ok) {
        navigate(`/duel/${id}`, { state: { vsAgent: true } });
        return;
      }
      if (res.reason === 'not_open' || res.reason === 'stale') openDuel.current = null;
      setActionError(friendlyError({ kind: 'agent', reason: res.reason }));
      setBusy(null);
    });
  };

  const challengeFriend = () => {
    if (cardId === null || !config) return Promise.resolve();
    return run('friend', 'createDuel', async () => {
      navigate(`/duel/${await duelId(config, cardId)}`);
    });
  };

  const pullAgain = () => {
    if (!config) return Promise.resolve();
    return run('pull', 'paidPull', async () => {
      const tokenId = await pullCard(actionDeps(config), { paid: true });
      navigate(`/pull?card=${encodeURIComponent(tokenId)}`);
    });
  };

  const price = config ? formatMon(config.pullPrice) : '0.05';
  const ready = cardId !== null && config !== null;
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
      {reveal && reveal.status !== 'ready' && <p className="body text-center text-ink-muted">Forging lore…</p>}
      <div className="mt-auto flex flex-col gap-3">
        {error && <Notice>{error}</Notice>}
        <Link
          to="/battle"
          aria-label="Card Battle, best of 3"
          className="flex h-14 items-center justify-between rounded-card bg-purple px-4 text-on-purple [touch-action:manipulation]"
        >
          <span className="flex flex-col">
            <span className="title leading-tight">Card Battle · Best of 3</span>
            <span className="data leading-tight opacity-80">10 onchain draws · no deck needed</span>
          </span>
          <span className="data" aria-hidden="true">
            →
          </span>
        </Link>
        <div className="flex items-center gap-3 pt-1">
          <span className="label text-ink-muted">Tap Blitz</span>
          <span className="h-px flex-1 bg-line" aria-hidden="true" />
        </div>
        <Button
          variant="secondary"
          busy={busy === 'agent'}
          busyLabel={CREATING}
          disabled={!ready || busy !== null}
          onClick={() => void fightAgent()}
        >
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
