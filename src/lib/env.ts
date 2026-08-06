/**
 * Parses an operator-supplied byte ceiling out of the environment.
 *
 * Returns `undefined` — never `0`, `NaN`, or a negative — for anything
 * unusable, so the caller falls back to its own documented default instead of
 * silently disabling a limit that exists to bound memory. Valid values are
 * floored because every caller feeds them to a byte comparison.
 */
export function byteLimitFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  // `< 1`, not `<= 0`: a fractional value like 0.5 clears a `> 0` test but
  // floors to 0, and the caller's `?? DEFAULT` cannot catch 0. That would set
  // the ceiling to zero and reject every response on its first byte.
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}
