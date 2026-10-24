import { useState } from 'react';
import { Link } from 'react-router-dom';

const GITHUB = 'https://github.com/zakyirsyaad/monicard';

/** In-page anchors: each targets a section heading id on the landing page. */
const ANCHORS = [
  { href: '#how', label: 'How to play' },
  { href: '#modes', label: 'Modes' },
  { href: '#why', label: 'Why Monad' },
  { href: '#orgs', label: 'Organizers' },
  { href: '#contracts', label: 'Contracts' },
] as const;

const NAV_LINK = 'body text-ink-muted hover:text-ink [touch-action:manipulation]';

/** Sticky top bar: wordmark, section anchors, GitHub, and the primary Play action. Mobile folds the anchors into a menu. */
export function NavBar() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="mx-auto flex h-14 w-full max-w-[1040px] items-center gap-4 px-4">
        <a href="#top" onClick={close} className="flex items-center gap-2 [touch-action:manipulation]">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="title font-extrabold tracking-tight">Monicard</span>
        </a>
        <nav className="ml-auto hidden items-center gap-5 md:flex" aria-label="Sections">
          {ANCHORS.map((a) => (
            <a key={a.href} href={a.href} className={NAV_LINK}>
              {a.label}
            </a>
          ))}
          <a href={GITHUB} target="_blank" rel="noreferrer" className={NAV_LINK}>
            GitHub
          </a>
        </nav>
        <Link
          to="/battle"
          className="title ml-auto flex h-10 items-center rounded-card bg-purple px-4 text-on-purple [touch-action:manipulation] md:ml-0"
        >
          Play
        </Link>
        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-card border border-line [touch-action:manipulation] md:hidden"
          aria-expanded={open}
          aria-controls="nav-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true" className="flex w-4 flex-col gap-[3px]">
            <span className={`h-[2px] w-4 bg-ink transition-transform ${open ? 'translate-y-[5px] rotate-45' : ''}`} />
            <span className={`h-[2px] w-4 bg-ink transition-opacity ${open ? 'opacity-0' : ''}`} />
            <span className={`h-[2px] w-4 bg-ink transition-transform ${open ? '-translate-y-[5px] -rotate-45' : ''}`} />
          </span>
        </button>
      </div>
      {open && (
        <nav id="nav-menu" className="border-t border-line md:hidden" aria-label="Sections">
          <ul className="mx-auto flex w-full max-w-[1040px] flex-col px-4 py-2">
            {ANCHORS.map((a) => (
              <li key={a.href}>
                <a href={a.href} onClick={close} className="title flex h-12 items-center border-b border-line">
                  {a.label}
                </a>
              </li>
            ))}
            <li>
              <a href={GITHUB} target="_blank" rel="noreferrer" className="title flex h-12 items-center">
                GitHub
              </a>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}
