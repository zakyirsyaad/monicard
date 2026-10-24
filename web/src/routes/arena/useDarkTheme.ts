import { useLayoutEffect } from 'react';

/** Projector screen is dark; the phone screens are light, so leaving restores light. */
export function useDarkTheme(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = 'dark';
    return () => {
      root.dataset.theme = 'light';
    };
  }, []);
}
