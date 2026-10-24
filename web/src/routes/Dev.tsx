import { useEffect, useState, type ReactNode } from 'react';
import { CardImage } from '../components/CardImage';
import { GameCard } from '../components/GameCard';
import { HpBar } from '../components/HpBar';
import { LatencyBadge } from '../components/LatencyBadge';
import { SkillButton } from '../components/SkillButton';
import { TapButton } from '../components/TapButton';

type Theme = 'light' | 'dark';

const SAMPLE_TX_HASH = `0x${'ab12cd34'.repeat(8)}`;
const MOCK_CARD_SRC = '/mock/card.svg';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="label text-ink-muted">{title}</h2>
      {children}
    </section>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(
    () => () => {
      document.documentElement.dataset.theme = 'light';
    },
    [],
  );

  const next: Theme = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="title rounded-card border border-line bg-surface-raised px-4 py-2 text-ink"
    >
      {next === 'dark' ? 'Dark' : 'Light'}
    </button>
  );
}

function DuelMock() {
  return (
    <div className="space-y-4 rounded-card border border-line bg-surface p-4">
      <LatencyBadge block={73562481} latencyMs={312} txHash={SAMPLE_TX_HASH} />
      <HpBar side="opponent" name="AI Agent · Lv.4" hp={1520} maxHp={1900} pendingDamage={160} />
      <div className="grid grid-cols-1 gap-2">
        <GameCard nadmon={{ id: 'embrit', name: 'Embrit' }} element={0} rarity={0} atk={11} />
        <GameCard nadmon={{ id: 'abyssnad', name: 'Abyssnad' }} element={1} rarity={3} atk={17} />
      </div>
      <HpBar side="self" name="You" hp={1420} maxHp={1950} pendingDamage={0} />
      <div>
        <SkillButton damage={380} used={false} onUse={() => undefined} />
        <div className="mt-3">
          <TapButton state="active" onTap={() => undefined} />
        </div>
      </div>
    </div>
  );
}

export function Dev() {
  const [taps, setTaps] = useState(0);

  return (
    <main className="min-h-screen bg-surface text-ink">
      <div className="mx-auto max-w-[420px] space-y-6 px-4 py-6">
        <div className="flex items-center justify-between">
          <h1 className="display">Components</h1>
          <ThemeToggle />
        </div>

        <Section title="HpBar">
          <HpBar side="opponent" name="AI Agent · Lv.4" hp={1520} maxHp={1900} pendingDamage={160} />
          <HpBar side="self" name="You" hp={1420} maxHp={1950} pendingDamage={0} />
          <HpBar side="opponent" name="Edge case" hp={50} maxHp={1900} pendingDamage={200} />
        </Section>

        <Section title="TapButton">
          <TapButton state="countdown" countdown={3} onTap={() => undefined} />
          <TapButton state="active" onTap={() => setTaps((n) => n + 1)} />
          <p className="data text-ink-muted">Taps: {taps}</p>
          <TapButton state="ended" onTap={() => undefined} />
        </Section>

        <Section title="SkillButton">
          <SkillButton damage={380} used={false} onUse={() => undefined} />
          <SkillButton damage={380} used onUse={() => undefined} />
          <SkillButton damage={380} used={false} disabled onUse={() => undefined} />
        </Section>

        <Section title="LatencyBadge">
          <LatencyBadge block={73562481} latencyMs={312} txHash={SAMPLE_TX_HASH} />
          <LatencyBadge block={73562482} latencyMs={1240} />
          <LatencyBadge block={73562483} latencyMs={2870} />
          <LatencyBadge block={null} latencyMs={null} />
        </Section>

        <Section title="GameCard compact">
          <GameCard nadmon={{ id: 'abyssnad', name: 'Abyssnad' }} element={1} rarity={3} atk={17} />
          <GameCard nadmon={{ id: 'sparkit', name: 'Sparkit' }} element={2} rarity={1} atk={12} />
          <GameCard nadmon={{ id: 'embrit', name: 'Embrit' }} element={0} rarity={0} atk={11} />
        </Section>

        <Section title="CardImage">
          <div className="flex flex-wrap gap-4">
            <CardImage id="sparkit" name="Sparkit" rarity={1} src={MOCK_CARD_SRC} />
            <CardImage id="abyssnad" name="Abyssnad" rarity={3} src={MOCK_CARD_SRC} />
          </div>
        </Section>

        <Section title="Duel screen mock">
          <DuelMock />
        </Section>
      </div>
    </main>
  );
}
