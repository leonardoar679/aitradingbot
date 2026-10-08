// THE HARD LIMITS: ceilings in code, above every setting (the V5 document, §5 and §107).
//
// The document puts hard safety rules above system defaults, user settings and research
// overrides: a setting may be anything a person chooses, up to a ceiling that nothing but the code
// moves. Until 8 October 2026 only one such ceiling existed, on a real order's size
// (liveTradingService); the rest of the limits were choice lists, or free numbers with no top.
// This object is the one place the ceilings live. Each is applied where its store is healed on
// read (a stored value over it is clamped, and the effective-configuration card says so), and where
// a setting is written (a value over it is refused with the ceiling named). The choice lists are
// pinned against them by test, so a list cannot drift above a ceiling.
//
// Research overrides are not a layer (the user's choice of 8 October 2026): the engine's
// thresholds are constants, and these ceilings are too.

export const HARD_LIMITS = {
  /** A real order's exposure in quote, whatever leverage paid for it. Code-only: no UI, setting or
   * IPC call can raise it. */
  liveMaxOrderQuote: 25,
  /** The share of an account that one of the app's own paper trades, or a real order filled in from
   * a call, risks at its stop. The tops of both choice lists. */
  riskPctMax: 2,
  /** The AI budget for one UTC day, in US dollars. */
  aiDailyCapUsdMax: 100,
  /** Events the watch may ask about in one UTC day: the top of its choice list. */
  watchEventsPerDayMax: 40,
  /** Models one event is put to. */
  watchModelsMax: 6,
  /** Pairs the scanner watches: the top of its choice list. */
  scannerUniverseMax: 100
} as const

/** The daily loss limit that disarms the session is never above the day's cap: a loss limit above
 * what can be placed in a day never trips, and would read as a limit that is none. Applied on read
 * and on write beside the ceilings above. */
export function dailyLossWithinCap(dailyLossLimitQuote: number, dailyCapQuote: number): number {
  return Math.min(dailyLossLimitQuote, dailyCapQuote)
}

/** A stored number held to a ceiling: the value, or the ceiling when it is over. Anything that is
 * not a finite number is the caller's default. */
export function clampedToHardLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(0, value), max)
}

/** Why a value cannot be written over a ceiling, or null when it can. */
export function hardLimitProblem(label: string, value: number, max: number, unit: string): string | null {
  if (value > max) return `${label} cannot be over ${max}${unit}: that is a ceiling in the code, not a setting.`
  return null
}
