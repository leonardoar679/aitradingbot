import { UNCERTAINTY_LINES, bootstrapOverHours, type Interval } from '../forecast/uncertainty'
import type { Candle } from '../ipc'
import { ASSUMED_FUNDING_RATE, FUNDING_INTERVAL_SEC } from '../perp'
import type { RoundTrip } from './roundTrips'

// COULD IT BE FOLLOWED (V8-S6-DELAY; V8 Stage 6, 26 October 2026)? A follower sees a trade only after it is made. Each
// of a trader's recent completed round trips is copied late -- entered and left 2, 5 and 15 minutes after the trader,
// at the open of the next one-minute bar of the venue's perpetual -- and charged what a follower would pay: the venue's
// taker fee each way, the larger of 2 bps and the book's impact at the stake each way, and the funding the copy's hold
// crosses at the venue's published rates (an assumed rate against the position where none is published), with a second
// row at twice the fees and impact. Each row's mean net per trip has its 95% interval resampled by the trading day the
// trip closed on. A trader is followable only at a delay a follow has measured live, and only where that row's interval
// is wholly above 0: until a follow runs, no trader is called followable. Rows at 0 and 30 seconds need one-second bars,
// which no venue gives for its perpetuals, and are not shown.

export const DELAY_VERSION = 'trader-delay-v1'

export const DELAY_LINES = {
  version: DELAY_VERSION,
  delaysMin: [2, 5, 15],
  /** The impact charged each way is at least this, in basis points. */
  minImpactBps: 2,
  /** The fees and impact charged once, and twice. */
  costMultipliers: [1, 2],
  /** The trips copied: those closed in the last 90 days, the most recent 500 at most. */
  lookbackDays: 90,
  maxTrips: 500,
  /** The copy book's largest stake: 10% of its 10,000 USDT, where the book's impact is read. */
  stakeQuote: 1000,
  level: 0.95,
  /** A bar's open is the price only where the bar starts within this many seconds of the moment. */
  maxGapSec: 120,
  seed: 20_261_026
} as const

export interface DelayCosts {
  venue: 'binance' | 'bitget'
  symbol: string
  takerFeePct: number
  /** The book's impact at the stake, each way, in percent; null where no book was read. */
  impactPct: number | null
}

export interface FundingRate {
  timeSec: number
  rate: number
}

export interface DelayRow {
  delayMin: number
  costMultiplier: number
  /** Trips copied, and trips that could not be: no bar near their moments. */
  n: number
  missing: number
  meanNetPct: number | null
  interval: Interval | null
  /** The interval is wholly above 0 at this delay and these costs. */
  aboveZero: boolean
}

export interface DelayResult {
  version: typeof DELAY_VERSION
  rows: DelayRow[]
  /** The trips the rows are of, the oldest close among them, and those of coins no venue's bars cover. */
  trips: number
  sinceMs: number | null
  noVenue: number
  /** Coins whose book was not read: 2 bps charged. And trips whose funding was assumed: no published rate. */
  impactAssumed: string[]
  fundingAssumed: number
}

/** The open of the first bar starting at or after a moment, within the lines' gap; null where none is near. */
export function openAtOrAfter(bars: readonly Candle[], sec: number, maxGapSec: number = DELAY_LINES.maxGapSec): number | null {
  let low = 0
  let high = bars.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (bars[mid].time >= sec) {
      found = mid
      high = mid - 1
    } else low = mid + 1
  }
  if (found < 0) return null
  const bar = bars[found]
  return bar.time - sec <= maxGapSec && bar.open > 0 ? bar.open : null
}

/** The funding a position pays over a span, in percent of its value, at the rates published for the times it crosses:
 * a long pays a positive rate, a short a negative one. Null where no rate is published within the span's reach. */
export function fundingPaidPct(rates: readonly FundingRate[] | undefined, side: 'long' | 'short', fromSec: number, toSec: number): number | null {
  if (rates === undefined || rates.length === 0) return null
  const first = rates[0].timeSec
  const last = rates[rates.length - 1].timeSec
  // A span beyond what the rates cover is not known: the venue publishes a rate at least every eight hours.
  if (fromSec < first - 8 * 3600 || toSec > last + 8 * 3600) return null
  let paid = 0
  for (const rate of rates) if (rate.timeSec > fromSec && rate.timeSec <= toSec) paid += (side === 'long' ? rate.rate : -rate.rate) * 100
  return paid
}

/** V8-S6-DELAY: a trader's recent trips copied late, at each delay and each cost. `costs`, `bars` and `funding` are by
 * the trip's coin. */
export function delayOf(input: {
  trips: readonly RoundTrip[]
  costs: ReadonlyMap<string, DelayCosts>
  bars: ReadonlyMap<string, readonly Candle[]>
  funding: ReadonlyMap<string, readonly FundingRate[]>
  nowMs: number
  lines?: typeof DELAY_LINES
}): DelayResult {
  const lines = input.lines ?? DELAY_LINES
  const since = input.nowMs - lines.lookbackDays * 86_400_000
  const recent = [...input.trips]
    .filter((trip) => trip.closedAtMs >= since)
    .sort((a, b) => b.closedAtMs - a.closedAtMs)
    .slice(0, lines.maxTrips)
  const covered = recent.filter((trip) => input.costs.has(trip.coin) && input.bars.has(trip.coin))
  const impactAssumed = [...new Set(covered.filter((trip) => input.costs.get(trip.coin)?.impactPct === null).map((trip) => trip.coin))].sort()
  let fundingAssumed = 0
  const rows: DelayRow[] = []
  for (const delayMin of lines.delaysMin) {
    // The gross move and the funding at this delay, once; the costs per multiplier.
    const copied: { day: number; gross: number; funding: number; trade: number }[] = []
    let missing = 0
    for (const trip of covered) {
      const bars = input.bars.get(trip.coin) as readonly Candle[]
      const costs = input.costs.get(trip.coin) as DelayCosts
      const entrySec = trip.openedAtMs / 1000 + delayMin * 60
      const exitSec = trip.closedAtMs / 1000 + delayMin * 60
      const entry = openAtOrAfter(bars, entrySec, lines.maxGapSec)
      const exit = openAtOrAfter(bars, exitSec, lines.maxGapSec)
      if (entry === null || exit === null) {
        missing++
        continue
      }
      const gross = (trip.side === 'long' ? exit / entry - 1 : 1 - exit / entry) * 100
      let funding = fundingPaidPct(input.funding.get(trip.coin), trip.side, entrySec, exitSec)
      if (funding === null) {
        // No published rate: the assumed rate, always against the position.
        const crossed = Math.floor(exitSec / FUNDING_INTERVAL_SEC) - Math.floor(entrySec / FUNDING_INTERVAL_SEC)
        funding = crossed * ASSUMED_FUNDING_RATE * 100
        if (delayMin === lines.delaysMin[0]) fundingAssumed++
      }
      const impact = Math.max(lines.minImpactBps / 100, costs.impactPct ?? 0)
      copied.push({ day: Math.floor(trip.closedAtMs / 86_400_000), gross, funding, trade: 2 * costs.takerFeePct + 2 * impact })
    }
    for (const costMultiplier of lines.costMultipliers) {
      const nets = copied.map((entry) => entry.gross - costMultiplier * entry.trade - entry.funding)
      const resampled =
        nets.length === 0
          ? null
          : bootstrapOverHours(
              copied.map((entry, k) => ({ hour: entry.day, sample: [nets[k]] })),
              [(sums, count): number => sums[0] / count],
              1,
              { ...UNCERTAINTY_LINES, seed: lines.seed, level: lines.level }
            )
      const interval = resampled === null ? null : { low: resampled.figures[0].low, high: resampled.figures[0].high }
      rows.push({
        delayMin,
        costMultiplier,
        n: nets.length,
        missing,
        meanNetPct: nets.length === 0 ? null : nets.reduce((a, b) => a + b, 0) / nets.length,
        interval,
        aboveZero: interval !== null && interval.low > 0
      })
    }
  }
  return {
    version: DELAY_VERSION,
    rows,
    trips: covered.length,
    sinceMs: covered.length === 0 ? null : Math.min(...covered.map((trip) => trip.closedAtMs)),
    noVenue: recent.length - covered.length,
    impactAssumed,
    fundingAssumed
  }
}

/** Whether a trader can be followed: only at a delay a follow measured live, at the first row's costs, from the row of
 * the smallest delay at least that long; null until a follow has measured one. */
export function followableAt(result: DelayResult, liveDelaySec: number | null): { followable: boolean; delayMin: number } | null {
  if (liveDelaySec === null || !Number.isFinite(liveDelaySec)) return null
  const row = result.rows.filter((entry) => entry.costMultiplier === DELAY_LINES.costMultipliers[0] && entry.delayMin * 60 >= liveDelaySec).sort((a, b) => a.delayMin - b.delayMin)[0]
  if (row === undefined) return { followable: false, delayMin: Math.max(...DELAY_LINES.delaysMin) }
  return { followable: row.aboveZero, delayMin: row.delayMin }
}
