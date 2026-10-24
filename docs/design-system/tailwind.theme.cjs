// NadGacha Design System — Tailwind 3 theme mapped to the CSS variables in tokens.css.
// web/tailwind.config.cjs:
//   module.exports = {
//     content: ['./index.html', './src/**/*.{ts,tsx}'],
//     theme: { extend: require('../docs/design-system/tailwind.theme.cjs') },
//   };
// Colors are CSS variables, so Tailwind opacity modifiers (`bg-berry/40`) produce NO CSS.
// For a translucent fill use a separate element with `opacity-40`.
const color = (n) => `var(--${n})`;
const names = ['surface', 'surface-raised', 'surface-sunken', 'line', 'ink', 'ink-muted', 'purple', 'on-purple', 'purple-ink', 'purple-tint', 'deep', 'on-deep', 'berry', 'berry-tint', 'element-fire', 'element-water', 'element-lightning', 'rarity-common', 'rarity-rare', 'rarity-epic', 'rarity-legendary', 'focus'];
module.exports = {
  colors: Object.fromEntries(names.map((n) => [n, color(n)])),
  spacing: { 1: 'var(--space-1)', 2: 'var(--space-2)', 3: 'var(--space-3)', 4: 'var(--space-4)', 6: 'var(--space-6)', 8: 'var(--space-8)' },
  // Own names so Tailwind's default rounded-md / rounded-lg keep their usual meaning.
  borderRadius: { chip: 'var(--radius-sm)', card: 'var(--radius-md)', tap: 'var(--radius-lg)' },
  fontFamily: { sans: 'var(--font-sans)', mono: 'var(--font-mono)' },
};
