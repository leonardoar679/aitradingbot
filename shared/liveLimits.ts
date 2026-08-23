/** Clamps one real-money risk limit, and refuses a value that would quietly switch it off.
 *
 * Every gate in liveTradingService compares with `>` or `<=`, and both are false against NaN. So
 * a NaN limit does not merely misbehave -- it disables the check entirely: `quoteAmount > NaN` is
 * false, so any order size passes; `realizedPnlToday <= -NaN` is false, so the daily loss limit
 * never trips. Math.max(0, Math.min(NaN, HARD_MAX)) is NaN too, so the hard ceiling did not catch
 * it either. Infinity does the same to the two limits that have no hard ceiling.
 *
 * Reached through the Settings panel, which does Number(input) on a text value: "1e999" is a
 * legitimate entry for a number input and yields Infinity. Both then persist to disk and survive
 * a restart. Throwing is deliberate -- silently substituting a value would leave someone believing
 * they had set a limit they had not, which is the failure mode this whole guard exists to stop. */
export function clampLiveLimit(label: string, value: number, hardMax: number | null): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `${label} must be a real number (got ${String(value)}). A non-finite limit would silently switch off the check it is meant to enforce, so it has not been saved.`
    )
  }
  const atLeastZero = Math.max(0, value)
  return hardMax === null ? atLeastZero : Math.min(atLeastZero, hardMax)
}

/** The same rule applied to a value read back from disk, where throwing is the wrong response --
 * the file is already written and the app still has to start. JSON cannot represent NaN or
 * Infinity, so a file written before clampLiveLimit existed stores `null` instead, and the state
 * merge keeps it (object spread only skips `undefined`). A stored null then reaches the gates as
 * 0 after coercion: harmless for the order cap, but `realizedPnlToday <= -null` is `<= -0`, which
 * trips the daily loss limit the moment P&L is flat and locks live trading out for the day. */
export function loadedLiveLimit(value: unknown, fallback: number, hardMax: number | null): number {
  // The typeof clause looks redundant -- Number.isFinite does no coercion, so it already returns
  // false for null, undefined, '25' and {}. It is here for the compiler, not the runtime:
  // Number.isFinite is not a type guard, so without it `value` stays `unknown` and Math.max below
  // does not typecheck. Removing it is a mutation the tests cannot catch and tsc rejects outright.
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const atLeastZero = Math.max(0, value)
  return hardMax === null ? atLeastZero : Math.min(atLeastZero, hardMax)
}
