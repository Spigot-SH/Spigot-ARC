/**
 * Read a message off an unknown thrown value.
 *
 * TypeScript types a `catch` binding as `unknown`, because anything can be thrown — a string,
 * a number, `undefined`. Writing `catch (e)` silences that at the cost of losing every
 * check inside the handler. This narrows once, in one place, so callers stay type-safe.
 */
export const errorMessage = (error: unknown, fallback = 'Unknown error'): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return fallback;
};

/** Narrow an unknown throwable to a record so a known extra field can be read off it. */
export const errorField = <T>(error: unknown, field: string): T | undefined => {
  if (error && typeof error === 'object' && field in error) {
    return (error as Record<string, T>)[field];
  }
  return undefined;
};
