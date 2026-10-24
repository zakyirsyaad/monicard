import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { api } from '../lib/api';
import { RevertedError } from '../lib/actions';
import { toFriendly } from '../lib/errors';
import { pullCard } from '../lib/flows';
import { EXPLORER, formatInt, formatMon } from '../lib/format';
import { NETWORK } from '../lib/network';
import { RARITIES, RARITY_ODDS } from '../lib/game';
import { actionDeps, burnerAccount } from '../lib/player';
import { takeReturnTo } from '../lib/returnTo';
import { useArenaSocket } from '../lib/useArenaSocket';
import { BattleDemo } from './home/BattleDemo';
import { Contracts } from './home/Contracts';
import { LiveStrip } from './home/LiveStrip';
import { NavBar } from './home/NavBar';
import './home/home.css';
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

const GITHUB = 'https://github.com/zakyirsyaad/monicard';
const SOCIAL = [
  { name: 'Demo video', href: 'https://youtu.be/N-FRL6CPAis' },
  { name: 'Post on X', href: 'https://x.com/0xKayz_/status/2113913855734862058' },
  { name: 'LinkedIn', href: 'https://lnkd.in/p/gB2QTGnT' },
  { name: 'Instagram', href: 'https://www.instagram.com/reel/De3yo2qx4-h/' },
] as const;
const SCAN = `${EXPLORER}/address`;

const SECTION = 'flex flex-col gap-4 border-t border-line pt-6 md:pt-8';
const PANEL = 'flex flex-col gap-3 rounded-card border border-line bg-surface-raised p-4';
const WRAP = 'mx-auto w-full max-w-[1040px] px-4';

/** Adds `in` once the element scrolls into view, so `.reveal` children can stagger in. */
function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, seen };
}

function Wheel() {
  return (
    <p className="data" aria-label="Water beats Fire, Fire beats Lightning, Lightning beats Water">
      <span className="text-element-water">Water</span> &gt; <span className="text-element-fire">Fire</span> &gt;{' '}
      <span className="text-element-lightning">Lightning</span> &gt; <span className="text-element-water">Water</span>
    </p>
  );
}

const FAN = ['sparkit', 'dripnad', 'embrit'] as const;

function HowToPlay() {
  const { ref, seen } = useInView<HTMLOListElement>();
  const rv = `reveal${seen ? ' in' : ''}`;
  return (
    <section className={SECTION} aria-labelledby="how">
      <h2 id="how" className="title">
        How to play
      </h2>
      <ol ref={ref} className="grid gap-3 md:grid-cols-3">
        <li className={`${PANEL} ${rv}`} style={{ '--i': 0 } as React.CSSProperties}>
          <span className="data text-ink-muted">1</span>
          <h3 className="display">Draw</h3>
          <p className="body text-ink-muted">
            Each turn the contract draws one random card onchain and adds it to your hand. No deck to build.
          </p>
          <div className="mt-auto flex gap-2 pt-2" aria-hidden="true">
            {FAN.map((id, i) => (
              <img
                key={id}
                src={`/nadmon/${id}.svg`}
                alt=""
                className={`reveal${seen ? ' in' : ''} h-auto w-1/3 rounded-chip border border-line`}
                style={{ '--i': i + 2 } as React.CSSProperties}
              />
            ))}
          </div>
        </li>
        <li className={`${PANEL} ${rv}`} style={{ '--i': 1 } as React.CSSProperties}>
          <span className="data text-ink-muted">2</span>
          <h3 className="display">Place or hold</h3>
          <p className="body text-ink-muted">
            The board has 3 slots. Every card on it strikes the front card of your opponent at the same time. The
            element wheel adds a ×1.5 bonus.
          </p>
          <div className="mt-auto flex flex-col gap-2 pt-2">
            <div className="flex gap-2" aria-hidden="true">
              <img
                src="/nadmon/infernad.svg"
                alt=""
                className={`reveal${seen ? ' in' : ''} h-auto w-1/3 rounded-chip border-2 border-purple`}
                style={{ '--i': 3 } as React.CSSProperties}
              />
              <span className="aspect-[240/150] w-1/3 rounded-chip border border-line bg-surface-sunken" />
              <span className="aspect-[240/150] w-1/3 rounded-chip border border-line bg-surface-sunken" />
            </div>
            <Wheel />
          </div>
        </li>
        <li className={`${PANEL} ${rv}`} style={{ '--i': 2 } as React.CSSProperties}>
          <span className="data text-ink-muted">3</span>
          <h3 className="display">Win</h3>
          <p className="body text-ink-muted">
            Use your Special once per match for ×2 damage. Knock out two cards and the match is yours.
          </p>
          <div className="mt-auto flex items-center gap-2 pt-2" aria-hidden="true">
            <span className={`reveal${seen ? ' in' : ''} data-lg rounded-chip bg-berry-tint px-3 py-1 text-berry`} style={{ '--i': 3 } as React.CSSProperties}>
              KO 1
            </span>
            <span className={`reveal${seen ? ' in' : ''} data-lg rounded-chip bg-berry-tint px-3 py-1 text-berry`} style={{ '--i': 4 } as React.CSSProperties}>
              KO 2
            </span>
            <span className={`reveal${seen ? ' in' : ''} data-lg rounded-chip bg-purple-tint px-3 py-1 text-purple-ink`} style={{ '--i': 5 } as React.CSSProperties}>
              ×2
            </span>
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

function WhyMonad() {
  const { duels } = useArenaSocket('all');
  const parallel = duels.size > 1 ? formatInt(duels.size) : 'Many';
  const items = [
    { n: '1 tx', body: 'per move. Every action is an onchain transaction, not a database write.' },
    { n: '~300 ms', body: 'blocks. Turns land fast enough to feel instant.' },
    { n: parallel, body: 'matches in parallel. A whole room plays at once.' },
  ];
  return (
    <section className="bg-deep text-on-deep" aria-labelledby="why">
      <div className={`${WRAP} flex flex-col gap-6 py-8 md:py-12`}>
        <h2 id="why" className="title">
          Why Monad
        </h2>
        <ul className="grid gap-6 md:grid-cols-3">
          {items.map((w) => (
            <li key={w.body} className="flex flex-col gap-2">
              <span className="font-mono text-[40px] font-semibold leading-none tabular-nums md:text-[56px]">{w.n}</span>
              <p className="body">{w.body}</p>
            </li>
          ))}
        </ul>
        <Link
          to="/arena"
          className="title flex h-12 w-full items-center justify-center rounded-card bg-on-deep px-6 text-deep md:w-auto md:self-start"
        >
          Watch the live arena
        </Link>
      </div>
    </section>
  );
}

const REVENUE = [
  'Paid packs at 0.05 MON per pull',
  'Staked battles: the winner takes the pot, 5% goes to the treasury',
  '5% creator royalty on every resale (ERC-2981)',
] as const;

function ProjectorMock() {
  return (
    <div data-theme="dark" className="flex flex-col gap-3 rounded-card border-2 border-line bg-surface p-4 text-ink" aria-hidden="true">
      <p className="label text-ink-muted">Your event · Presented by Your Brand</p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="data w-10 text-ink-muted">P1</span>
          <span className="h-2 flex-1 rounded-chip bg-surface-sunken">
            <span className="block h-2 w-3/4 rounded-chip bg-purple" />
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="data w-10 text-ink-muted">AI</span>
          <span className="h-2 flex-1 rounded-chip bg-surface-sunken">
            <span className="block h-2 w-1/3 rounded-chip bg-berry" />
          </span>
        </div>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} className={`h-4 rounded-chip border ${i % 3 === 0 ? 'border-purple' : 'border-line'} bg-surface-sunken`} />
        ))}
      </div>
      <p className="label text-ink-muted">Scan to play</p>
    </div>
  );
}

function Organizers() {
  return (
    <section className={SECTION} aria-labelledby="orgs">
      <h2 id="orgs" className="title">
        For event organizers
      </h2>
      <div className="grid gap-6 md:grid-cols-2 md:items-center">
        <ProjectorMock />
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="display">Your arena on the big screen</h3>
            <p className="body mt-2 text-ink-muted">
              A branded live view for the projector with your event name and sponsor. Gas is sponsor-funded, so
              attendees scan, play and pay nothing.
            </p>
          </div>
          <div>
            <h3 className="title">How it earns</h3>
            <ul className="body mt-2 flex flex-col gap-1 text-ink-muted">
              {REVENUE.map((r) => (
                <li key={r} className="border-t border-line pt-1">
                  {r}
                </li>
              ))}
            </ul>
          </div>
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
        {SOCIAL.map((l) => (
          <a key={l.name} className="underline underline-offset-4" href={l.href} target="_blank" rel="noreferrer">
            {l.name}
          </a>
        ))}
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
      <p className="data text-ink-muted">Live on {NETWORK.label} · Deployed on Monad mainnet and testnet · Built at Monad Blitz Jogja Vol. 2</p>
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

function ScanToPlay() {
  const { origin, host } = window.location;
  return (
    <div className="hidden items-center gap-4 md:flex">
      <div data-theme="light" className="rounded-chip border border-line bg-surface-raised p-2 text-ink">
        <QRCodeSVG value={`${origin}/`} size={96} fgColor="currentColor" bgColor="transparent" />
      </div>
      <div>
        <p className="title">Scan to play on your phone</p>
        <p className="data text-ink-muted">{host}</p>
      </div>
    </div>
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
    <main id="top" className="landing min-h-[100dvh] bg-surface text-ink">
      <NavBar />
      <div className={`${WRAP} flex flex-col gap-6 py-6 md:gap-8 md:py-10`}>
        <InAppBrowserBanner />
        <div className="grid gap-6 md:grid-cols-[1.1fr_1fr] md:items-center md:gap-10">
          <header className="flex flex-col gap-3">
            {config && (
              <p className="label text-ink-muted">
                {config.event.name}
                {sponsor ? ` · Presented by ${sponsor}` : ''}
              </p>
            )}
            <h1 className="flex flex-col gap-1">
              <span className="text-[56px] font-extrabold leading-none tracking-tight md:text-[96px]">Monicard</span>
              <span className="text-[28px] font-bold leading-[32px] md:text-[44px] md:leading-[48px]">
                Every move is a <span className="text-purple">transaction.</span>
              </span>
            </h1>
            <p className="title">Onchain card battles on Monad.</p>
            <p className="body text-ink-muted">Scan, play in 3 seconds. No wallet, no seed phrase.</p>
            <div className="mt-2 flex flex-col gap-3 md:max-w-[360px]">
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
            <ScanToPlay />
          </header>
          <BattleDemo />
        </div>
        <LiveStrip />
        <HowToPlay />
        <Modes />
      </div>
      <WhyMonad />
      <div className={`${WRAP} flex flex-col gap-6 py-6 md:gap-8 md:py-10`}>
        <Organizers />
        <Odds />
        <section className="flex flex-col items-start gap-4 rounded-card border border-line bg-purple-tint p-6 md:flex-row md:items-center md:justify-between" aria-labelledby="ready">
          <h2 id="ready" className="display text-purple-ink md:text-[40px] md:leading-[44px]">
            Ready? Play Card Battle
          </h2>
          <div className="w-full md:max-w-[280px]">
            <Button onClick={() => navigate('/battle')}>Play Card Battle</Button>
          </div>
        </section>
        <Contracts />
        <Footer config={config} />
      </div>
    </main>
  );
}
