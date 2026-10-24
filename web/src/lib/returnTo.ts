export const RETURN_TO_KEY = 'nad.returnTo';

/** Reads and clears the path a screen asked us to return to. Only same-origin paths are honoured. */
export function takeReturnTo(): string | null {
  try {
    const value = sessionStorage.getItem(RETURN_TO_KEY);
    if (value === null) return null;
    sessionStorage.removeItem(RETURN_TO_KEY);
    return value.startsWith('/') && !value.startsWith('//') ? value : null;
  } catch {
    return null;
  }
}
