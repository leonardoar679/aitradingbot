// WHEN A FORECAST IS MADE AGAIN BEFORE THE NEXT CLOSE (the V6 document, §39; V6 Stage 7, 13 October
// 2026). Every pair is forecast at every five-minute close. Between closes a pair's forecast is made
// again -- from the same closed bars, which have not changed, with what has: the live book, the
// adaptive levels, and from V6 Stage 8 the news -- when one of these has happened since it was made:
// - a story of impact 70 or more names the coin;
// - the scanner raised an event on it;
// - the live price left the forecast's 80% range at its lead horizon (it is invalidated);
// - a volume shock: the minute forming has traded three times the pair's usual minute;
// - Bitcoin's last fifteen minutes crossed the line its sharp moves widen the ranges at (V6.1,
//   shared/forecast/shock.ts): every pair, since the ranges it widens are every pair's.
// At most once a minute a pair, so that a busy story does not forecast a coin sixty times an hour.
// A change of the market's regime is read from the bars, so it is a close's, and every pair is
// forecast then anyway.

export const REFRESH_LINES = {
  minGapMs: 60_000,
  newsImpact: 70,
  volumeShock: 3
} as const

export type RefreshReason = 'news' | 'event' | 'band' | 'volume' | 'market'

export interface RefreshCheck {
  nowMs: number
  /** When the pair was last forecast again between closes; null if not since its close. */
  lastRefreshAt: number | null
  /** The highest impact of a story naming the coin seen since its forecast was made. */
  newsImpact?: number | null
  /** Whether the scanner raised an event on it since. */
  newEvent?: boolean
  /** The live price and the lead horizon's P10 and P90 prices. */
  livePrice?: number | null
  band?: readonly [number, number] | null
  /** The minute forming's volume and the pair's usual minute's. */
  minuteVolume?: number | null
  usualMinuteVolume?: number | null
  /** Whether Bitcoin's last fifteen minutes have just crossed the sharp-move line (V6.1). */
  marketShock?: boolean
}

/** Why a pair's forecast should be made again now; none within a minute of the last time. */
export function refreshReasons(check: RefreshCheck): RefreshReason[] {
  if (check.lastRefreshAt !== null && check.nowMs - check.lastRefreshAt < REFRESH_LINES.minGapMs) return []
  const out: RefreshReason[] = []
  if (check.newsImpact !== null && check.newsImpact !== undefined && check.newsImpact >= REFRESH_LINES.newsImpact) out.push('news')
  if (check.newEvent === true) out.push('event')
  const price = check.livePrice
  if (price !== null && price !== undefined && check.band !== null && check.band !== undefined && (price < check.band[0] || price > check.band[1])) out.push('band')
  const volume = check.minuteVolume
  const usual = check.usualMinuteVolume
  if (volume !== null && volume !== undefined && usual !== null && usual !== undefined && usual > 0 && volume >= REFRESH_LINES.volumeShock * usual) out.push('volume')
  if (check.marketShock === true) out.push('market')
  return out
}
