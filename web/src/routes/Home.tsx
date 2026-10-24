import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { api } from '../lib/api';
import { RevertedError } from '../lib/actions';
import { toFriendly } from '../lib/errors';
import { pullCard } from '../lib/flows';
import { formatMon } from '../lib/format';
import { RARITIES, RARITY_ODDS } from '../lib/game';
import { rarityTextClass } from '../lib/labels';
import { actionDeps, burnerAccount } from '../lib/player';
import { takeReturnTo } from '../lib/returnTo';
import type { Account, Config } from '../lib/types';
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

const GITHUB = 'https://github.com/zakyirsyaad/monicard';
const SCAN = 'https://testnet.monadscan.com/address';

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

const SECTION = 'flex flex-col gap-4 border-t border-line pt-6';
const PANEL = 'flex flex-col gap-3 rounded-card border border-line bg-surface-raised p-4';

function Wheel() {
  return (
    <p className="data" aria-label="Water beats Fire, Fire beats Lightning, Lightning beats Water">
      <span className="text-element-water">Water</span> &gt; <span className="text-element-fire">Fire</span> &gt;{' '}
      <span className="text-element-lightning">Lightning</span> &gt; <span className="text-element-water">Water</span>
    </p>
  );
}

function HowToPlay() {
  return (
    <section className={SECTION} aria-labelledby="how">
      <h2 id="how" className="title">
        How to play
      </h2>
      <ol className="grid gap-3 md:grid-cols-3">
        <li className={PANEL}>
          <span className="data text-ink-muted">1</span>
          <h3 className="title">Draw</h3>
          <p className="body text-ink-muted">
            Each turn the contract draws one random card onchain and adds it to your hand. No deck to build.
          </p>
          <div className="flex gap-2" aria-hidden="true">
            {['sparkit', 'dripnad', 'embrit'].map((id) => (
              <img key={id} src={`/nadmon/${id}.svg`} alt="" className="h-auto w-1/3 rounded-chip border border-line" />
            ))}
          </div>
        </li>
        <li className={PANEL}>
          <span className="data text-ink-muted">2</span>
          <h3 className="title">Place or hold</h3>
          <p className="body text-ink-muted">
            The board has 3 slots. Every card on the board strikes the front card of your opponent at the same time.
            The element wheel adds a ×1.5 bonus.
          </p>
          <div className="mt-auto flex flex-col gap-2">
            <div className="flex gap-2" aria-hidden="true">
              <span className="h-10 flex-1 rounded-chip border-2 border-purple bg-purple-tint" />
              <span className="h-10 flex-1 rounded-chip border border-line bg-surface-sunken" />
              <span className="h-10 flex-1 rounded-chip border border-line bg-surface-sunken" />
            </div>
            <Wheel />
          </div>
        </li>
        <li className={PANEL}>
          <span className="data text-ink-muted">3</span>
          <h3 className="title">Win</h3>
          <p className="body text-ink-muted">
            Use your Special once per match for ×2 damage. Knock out two cards and the match is yours.
          </p>
          <div className="mt-auto flex gap-2" aria-hidden="true">
            <span className="data rounded-chip bg-berry-tint px-2 py-1 text-berry">KO 1</span>
            <span className="data rounded-chip bg-berry-tint px-2 py-1 text-berry">KO 2</span>
            <span className="data rounded-chip bg-purple-tint px-2 py-1 text-purple-ink">×2</span>
          </div>
        </li>
      </ol>
      <p className="body text-ink-muted">Fight the AI Agent or challenge a friend with a QR code.</p>
    </section>
  );
}

function Modes() {
  return (
    <section className={SECTION} aria-labelledby="modes">
      <h2 id="modes" className="title">
        Two modes
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        <Link to="/battle" className={`${PANEL} [touch-action:manipulation]`}>
          <h3 className="title">Card Battle</h3>
          <p className="body text-ink-muted">Turn-based. Draw, place and strike, best of 3.</p>
          <span className="label text-purple-ink">Main mode</span>
        </Link>
        <Link to="/play" className={`${PANEL} [touch-action:manipulation]`}>
          <h3 className="title">Tap Blitz</h3>
          <p className="body text-ink-muted">Real-time. Tap fast for 20 seconds, every tap batch is a transaction.</p>
          <span className="label text-ink-muted">Needs a card</span>
        </Link>
      </div>
    </section>
  );
}

const WHY = [
  { n: '1 tx', body: 'Every move is an onchain transaction, not a database write.' },
  { n: '~300 ms', body: 'Blocks land fast enough for turns to feel instant.' },
  { n: '∥', body: 'Matches run in parallel, so a whole room can play at once.' },
] as const;

function WhyMonad() {
  return (
    <section className={SECTION} aria-labelledby="why">
      <h2 id="why" className="title">
        Why Monad
      </h2>
      <ul className="grid gap-3 md:grid-cols-3">
        {WHY.map((w) => (
          <li key={w.n} className={PANEL}>
            <span className="data-lg">{w.n}</span>
            <p className="body text-ink-muted">{w.body}</p>
          </li>
        ))}
      </ul>
      <Link to="/arena" className="title text-purple-ink underline underline-offset-4">
        Watch the live arena
      </Link>
    </section>
  );
}

const REVENUE = [
  'Paid packs at 0.05 MON per pull',
  'Staked battles: the winner takes the pot, 5% goes to the treasury',
  '5% creator royalty on every resale (ERC-2981)',
] as const;

function Organizers() {
  return (
    <section className={SECTION} aria-labelledby="orgs">
      <h2 id="orgs" className="title">
        For event organizers
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        <div className={PANEL}>
          <h3 className="title">Your arena on the big screen</h3>
          <p className="body text-ink-muted">
            A branded live view for the projector with your event name and sponsor. Gas is sponsor-funded, so attendees
            scan, play and pay nothing.
          </p>
        </div>
        <div className={PANEL}>
          <h3 className="title">How it earns</h3>
          <ul className="body flex flex-col gap-1 text-ink-muted">
            {REVENUE.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Footer({ config }: { config: Config | null }) {
  const battle = (config?.contracts as (Config['contracts'] & { battle?: string }) | undefined)?.battle;
  const cards = config?.contracts.cards;
  const links = [
    { name: 'CardBattle', addr: battle },
    { name: 'NadCards', addr: cards },
  ].filter((l): l is { name: string; addr: string } => Boolean(l.addr));
  return (
    <footer className="flex flex-col gap-3 border-t border-line pt-6 pb-2">
      <nav className="body flex flex-wrap gap-x-4 gap-y-1 text-purple-ink" aria-label="Links">
        <a className="underline underline-offset-4" href={GITHUB} target="_blank" rel="noreferrer">
          GitHub
        </a>
        {links.map((l) => (
          <a
            key={l.name}
            className="underline underline-offset-4"
            href={`${SCAN}/${l.addr}#code`}
            target="_blank"
            rel="noreferrer"
          >
            {l.name} on MonadScan
          </a>
        ))}
      </nav>
      <p className="data text-ink-muted">Live on Monad testnet · Built at Monad Blitz Jogja Vol. 2</p>
    </footer>
  );
}

function Odds() {
  return (
    <p className="data text-ink-muted">
      {RARITIES.map((name, i) => `${name} ${RARITY_ODDS[i]}%`).join(' · ')}
      <span className="body block">Cards are rolled onchain and trade with a 5% creator royalty.</span>
    </p>
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
        // The landing stays readable for returning players; only a pending QR/duel link sends them on.
        if (acct.cardId !== null) {
          const back = takeReturnTo();
          if (back) {
            navigate(back, { replace: true });
            return;
          }
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
  const cta = paid ? `Pull a card · ${priceText} MON` : 'Pull a free card';
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
    <main className="min-h-[100dvh] bg-surface text-ink">
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-4 py-6 md:gap-8 md:py-8">
        <InAppBrowserBanner />
        <div className="grid gap-6 md:grid-cols-2 md:items-center md:gap-8">
          <header className="flex flex-col gap-3">
            {config && (
              <p className="label text-ink-muted">
                {config.event.name}
                {sponsor ? ` · Presented by ${sponsor}` : ''}
              </p>
            )}
            <h1 className="display">Monicard</h1>
            <p className="title">Onchain card battles on Monad. Every move is a transaction.</p>
            <p className="body text-ink-muted">Scan, play in 3 seconds. No wallet, no seed phrase.</p>
            <div className="mt-2 flex flex-col gap-3">
              {error && <Notice>{error}</Notice>}
              <Button onClick={() => navigate('/battle')}>Play Card Battle</Button>
              <Button
                variant="secondary"
                busy={busy}
                busyLabel="Pulling…"
                disabled={!config || !accountLoaded}
                onClick={() => void pull()}
              >
                {cta}
              </Button>
            </div>
          </header>
          <Hero />
        </div>
        <HowToPlay />
        <Modes />
        <WhyMonad />
        <Organizers />
        <Odds />
        <Footer config={config} />
      </div>
    </main>
  );
}
