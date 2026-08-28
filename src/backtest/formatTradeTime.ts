// Formatting trade timestamps for display.
//
// EVERYTHING HERE IS UTC, deliberately, and it is the only defensible choice in this app. The
// chart beside these figures is lightweight-charts rendering `UTCTimestamp` values, which it
// formats in UTC; the CSV export writes `entry_time_utc`; and the engine's candles are UTC to
// begin with. Showing local time in the trade list would put a clock next to a chart that
// disagreed with it by the viewer's offset -- a trade listed at 23:45 sitting on a candle labelled
// 14:45, with nothing on screen explaining the gap. The panel labels the column UTC once so the
// choice is visible rather than assumed.
//
// Kept pure and separate from the view so the formatting can be tested without rendering a chart.

const MINUTE = 60
const HOUR = 3600
const DAY = 86_400

function isUsable(unixSeconds: number): boolean {
  return Number.isFinite(unixSeconds) && unixSeconds > 0
}

/** `2026-06-12`. Empty string for an unusable timestamp rather than "Invalid Date", which is not
 * something to print into a table. */
export function formatUtcDate(unixSeconds: number): string {
  if (!isUsable(unixSeconds)) return ''
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

/** `14:45`. Seconds are dropped: no candle interval this app offers is finer than a minute. */
export function formatUtcTime(unixSeconds: number): string {
  if (!isUsable(unixSeconds)) return ''
  return new Date(unixSeconds * 1000).toISOString().slice(11, 16)
}

/** `06-12 14:45` — a compact stamp for a column too narrow to carry the year.
 *
 * Safe here specifically because both stamps in an expanded trade sit inside one row whose own
 * header carries the full date, so the year is never actually absent from the screen. */
export function formatUtcShort(unixSeconds: number): string {
  if (!isUsable(unixSeconds)) return ''
  const iso = new Date(unixSeconds * 1000).toISOString()
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
}

/** How long a position was held, at the coarsest useful precision: `5d 4h`, `18h 45m`, `45m`.
 *
 * Two units at most. A trend follower holds for weeks, and "38d 6h 12m" reads as noise where
 * "38d 6h" reads as a duration. Under a minute is shown as `<1m` rather than `0m`, since a
 * zero-length hold would look like a bug in the engine rather than a very short trade. */
export function formatHoldingDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < MINUTE) return '<1m'
  const days = Math.floor(seconds / DAY)
  const hours = Math.floor((seconds % DAY) / HOUR)
  const minutes = Math.floor((seconds % HOUR) / MINUTE)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}
