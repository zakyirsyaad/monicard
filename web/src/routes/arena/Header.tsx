import { explorerAddress, explorerTx, formatBlock, shortHex } from '../../lib/format';
import { statsItems, treasuryMon } from '../../lib/arenaView';
import type { Config, StatsMsg } from '../../lib/types';
import { NETWORK } from '../../lib/network';

const LINK_CLASS = 'text-purple-ink underline-offset-2 hover:underline';

export interface HeaderProps {
  config: Config;
  stats: StatsMsg | null;
  block: number;
  connected: boolean;
}

function ExplorerLink({ label, href, text }: { label: string; href: string; text: string }) {
  return (
    <span>
      {label}{' '}
      <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {text}
      </a>
    </span>
  );
}

export function Header({ config, stats, block, connected }: HeaderProps) {
  const items = statsItems(stats, treasuryMon(stats?.treasury ?? '0'));
  const lastTxHash = stats?.lastTxHash;

  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-8">
        <div className="min-w-0">
          <h1 className="display text-ink">Monicard</h1>
          <p className="title text-ink-muted">{config.event.name}</p>
          {config.event.sponsor && <p className="title text-ink-muted">Presented by {config.event.sponsor}</p>}
        </div>
        <ul className="data-lg flex flex-wrap justify-end gap-x-3 text-ink">
          {items.map((item, i) => (
            <li key={item.key}>
              {i > 0 && (
                <span aria-hidden="true" className="mr-3 text-ink-muted">
                  ·
                </span>
              )}
              {item.text}
            </li>
          ))}
        </ul>
      </div>
      <div className="data flex flex-wrap items-center gap-x-6 gap-y-1 text-ink-muted">
        <span>{NETWORK.label}</span>
        <ExplorerLink label="Cards" href={explorerAddress(config.contracts.cards)} text={shortHex(config.contracts.cards)} />
        <ExplorerLink label="Arena" href={explorerAddress(config.contracts.arena)} text={shortHex(config.contracts.arena)} />
        {lastTxHash && <ExplorerLink label="Latest tx" href={explorerTx(lastTxHash)} text={shortHex(lastTxHash)} />}
        <span className="ml-auto flex items-center gap-6">
          <span>{block > 0 ? formatBlock(block) : '#—'}</span>
          <span className={connected ? 'text-purple-ink' : 'text-berry'}>{connected ? 'Live' : 'Reconnecting…'}</span>
        </span>
      </div>
    </header>
  );
}
