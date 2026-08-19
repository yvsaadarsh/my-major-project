/**
 * Turn an unknown thrown value into something safe to show a user.
 *
 * Every client-side mutation in this app ends with the same shape:
 *
 *   catch (caught) {
 *     setError(caught instanceof Error ? caught.message : "Unable to do X.");
 *   }
 *
 * The `instanceof` guard matters — a rejected promise can carry anything, and
 * interpolating a non-Error into the UI produces "[object Object]". Written out
 * 45 times it was also 45 chances to forget the guard, so it lives here once.
 *
 * `ClientApiError` extends `Error`, so a message the server deliberately wrote
 * for a human (from `ApiError`) still wins over the fallback.
 */
export function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error && caught.message.trim().length > 0) {
    return caught.message;
  }

  return fallback;
}
