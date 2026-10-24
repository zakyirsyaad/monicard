import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { Screen } from '../components/Screen';
import { api } from '../lib/api';
import { RevertedError } from '../lib/actions';
import { toFriendly } from '../lib/errors';
import { pullCard } from '../lib/flows';
import { formatMon } from '../lib/format';
import { RARITIES, RARITY_ODDS } from '../lib/game';
import { rarityTextClass } from '../lib/labels';
import { actionDeps, burnerAccount } from '../lib/player';
import { takeReturnTo } from '../lib/returnTo';
import type { Account } from '../lib/types';
import { useConfig } from '../lib/useConfig';

const IN_APP_BROWSER = /Instagram|FBAN|FBAV|Line\/|Telegram|WhatsApp/i;

function InAppBrowserBanner() {
  if (typeof navigator === 'undefined' || !IN_APP_BROWSER.test(navigator.userAgent)) return null;
  return (
    <div className="rounded-card bg-purple-tint px-4 py-3 text-purple-ink">
      <p className="title">Open this link in your browser</p>
      <p className="body">This app keeps your wallet in this browser.</p>
    </div>
  );
}

/** Three Nadmon, one per element, stepped so the middle one leads. Line borders only (design system: no shadow or glow). */
const HERO = [
  { id: 'wavenad', name: 'Wavenad', border: 'border-element-water', weight: 'flex-1' },
  { id: 'infernad', name: 'Infernad', border: 'border-element-fire', weight: 'flex-[1.45]' },
  { id: 'voltnad', name: 'Voltnad', border: 'border-element-lightning', weight: 'flex-1' },
] as const;

function Hero() {
  return (
    <div className="flex items-end justify-center gap-2" role="group" aria-label="Fire, Water and Lightning Nadmon">
      {HERO.map((n) => (
        <img
          key={n.id}
          src={`/nadmon/${n.id}.svg`}
          alt={n.name}
          width={240}
          height={150}
          className={`${n.weight} ${n.border} block h-auto min-w-0 rounded-card border-2 bg-surface-sunken`}
        />
      ))}
    </div>
  );
}

function OddsTable() {
  return (
    <section className="flex flex-col gap-2">
      <table className="w-full overflow-hidden rounded-card border border-line bg-surface-raised">
        <tbody className="divide-y divide-line">
          {RARITIES.map((name, i) => (
            <tr key={name}>
              <th scope="row" className={`title px-4 py-3 text-left ${rarityTextClass[i]}`}>
                {name}
              </th>
              <td className="data px-4 py-3 text-right text-ink">{RARITY_ODDS[i]}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="label text-ink-muted">Rolled onchain</p>
    </section>
  );
}

export function Home() {
  const navigate = useNavigate();
  const { config } = useConfig();
  const [account, setAccount] = useState<Account | null>(null);
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freeUsed, setFreeUsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getAccount(burnerAccount().address).then(
      (acct) => {
        if (cancelled) return;
        if (acct.cardId !== null) {
          navigate(takeReturnTo() ?? '/play', { replace: true });
          return;
        }
        setAccount(acct);
        setAccountLoaded(true);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(toFriendly(err, { fn: 'getAccount' }));
        setAccountLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const paid = freeUsed || account?.hasPulled === true;
  const priceText = config ? formatMon(config.pullPrice) : '0.05';
  const cta = paid ? `Pull a new card · ${priceText} MON` : 'Pull your first card · free';
  const sponsor = config?.event.sponsor;

  const pull = async () => {
    if (!config || busy) return;
    setBusy(true);
    setError(null);
    try {
      const tokenId = await pullCard(actionDeps(config), { paid });
      navigate(`/pull?card=${encodeURIComponent(tokenId)}`);
    } catch (err) {
      if (err instanceof RevertedError && err.fn === 'freePull') setFreeUsed(true);
      setError(toFriendly(err, { fn: paid ? 'paidPull' : 'freePull' }));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <InAppBrowserBanner />
      <header className="flex flex-col gap-2">
        {config && (
          <p className="label text-ink-muted">
            {config.event.name}
            {sponsor ? ` · Presented by ${sponsor}` : ''}
          </p>
        )}
        <h1 className="display">Monicard</h1>
        <p className="body text-ink-muted">Real-time 1v1 card duels on Monad testnet.</p>
      </header>
      <Hero />
      <OddsTable />
      <div className="mt-auto flex flex-col gap-3">
        {error && <Notice>{error}</Notice>}
        <Button busy={busy} busyLabel="Pulling…" disabled={!config || !accountLoaded} onClick={() => void pull()}>
          {cta}
        </Button>
      </div>
    </Screen>
  );
}
