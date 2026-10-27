import { accountValueAt, type AccountState, type AccountValuePoint, type LedgerUpdate } from './hyperliquid'
import type { RoundTrip, RoundTrips } from './roundTrips'

// A TRADER'S FIGURES (V8 Stage 6, 26 October 2026): what their completed round trips made after fees and funding, how
// often they made it, how far they fell from a high, how long they held, how much they put at stake and at what
// leverage, what they hold now, and on which coins -- the rebates a maker earns shown apart. Every figure is the
// round trips' own: deposits and withdrawals move no figure here, and are shown beside them. Arithmetic only.

export interface TraderFigures {
  trips: number
  partial: number
  spotFills: number
  span: { fromMs: number; toMs: number; calendarDays: number; tradingDays: number } | null
  /** In USDC: what the trips closed before fees, their fees (rebates counted against them), the rebates alone, the
   * funding, and the net of all of it. */
  money: { realized: number; fees: number; rebates: number; funding: number; net: number }
  /** The share of trips that made money after fees and funding. */
  winRate: number | null
  /** The largest fall of the trips' cumulative net from a high, in USDC, and as a share of the account's value at that
   * high where the account's history gives it. */
  drawdown: { usdc: number; pctOfAccount: number | null }
  /** Holding times in minutes: the median and the 10th and 90th percentiles. */
  holdMin: { p10: number; median: number; p90: number } | null
  /** What a trip put at stake at its entry price, the median: its size. */
  stake: { medianUsdc: number } | null
  /** What a trip put at stake over the account's value when it opened, where the account's history gives it: the median
   * trip's leverage and the largest. */
  leverage: { median: number; max: number; trips: number } | null
  /** Money in and out of the account over the record's span: deposits, withdrawals. */
  ledger: { deposits: number; withdrawals: number }
  coins: { coin: string; trips: number; net: number }[]
  /** Open now, as the venue reports them, and their unrealized result. */
  open: { positions: AccountState['positions']; unrealized: number; accountValue: number | null }
}

const DAY_MS = 86_400_000

function quantile(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) return Number.NaN
  const at = (sorted.length - 1) * share
  const low = Math.floor(at)
  const high = Math.ceil(at)
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low)
}

const median = (values: readonly number[]): number => quantile([...values].sort((a, b) => a - b), 0.5)

/** A trader's figures from their round trips, their account's history, its ledger and its state now. */
export function traderFiguresOf(input: { roundTrips: RoundTrips; values: readonly AccountValuePoint[]; ledger: readonly LedgerUpdate[]; state: AccountState | null }): TraderFigures {
  const { roundTrips, values, ledger, state } = input
  const trips: RoundTrip[] = [...roundTrips.trips].sort((a, b) => a.closedAtMs - b.closedAtMs)
  const sum = (pick: (trip: RoundTrip) => number): number => trips.reduce((total, trip) => total + pick(trip), 0)
  const money = { realized: sum((trip) => trip.realizedPnl), fees: sum((trip) => trip.fees), rebates: sum((trip) => trip.rebates), funding: sum((trip) => trip.funding), net: sum((trip) => trip.net) }

  // The cumulative net, trip by trip as each closed, and its largest fall from a high.
  let cumulative = 0
  let peak = 0
  let peakAtMs = trips[0]?.closedAtMs ?? 0
  let worst = 0
  let worstPeakAtMs = peakAtMs
  for (const trip of trips) {
    cumulative += trip.net
    if (cumulative > peak) {
      peak = cumulative
      peakAtMs = trip.closedAtMs
    }
    if (peak - cumulative > worst) {
      worst = peak - cumulative
      worstPeakAtMs = peakAtMs
    }
  }
  const valueAtPeak = accountValueAt(values, worstPeakAtMs)

  const shares = trips.map((trip) => {
    const value = accountValueAt(values, trip.openedAtMs)
    return value !== null && value > 0 ? trip.entryNotional / value : null
  })
  const known = shares.filter((share): share is number => share !== null)

  const coins = new Map<string, { coin: string; trips: number; net: number }>()
  for (const trip of trips) {
    const mine = coins.get(trip.coin) ?? { coin: trip.coin, trips: 0, net: 0 }
    mine.trips++
    mine.net += trip.net
    coins.set(trip.coin, mine)
  }

  const fromMs = trips.length === 0 ? null : Math.min(...trips.map((trip) => trip.openedAtMs))
  const toMs = trips.length === 0 ? null : Math.max(...trips.map((trip) => trip.closedAtMs))
  const holds = trips.map((trip) => (trip.closedAtMs - trip.openedAtMs) / 60_000).sort((a, b) => a - b)
  const inSpan = (update: LedgerUpdate): boolean => fromMs !== null && toMs !== null && update.timeMs >= fromMs && update.timeMs <= toMs
  return {
    trips: trips.length,
    partial: roundTrips.partial,
    spotFills: roundTrips.spotFills,
    span:
      fromMs === null || toMs === null
        ? null
        : { fromMs, toMs, calendarDays: (toMs - fromMs) / DAY_MS, tradingDays: new Set(trips.map((trip) => Math.floor(trip.closedAtMs / DAY_MS))).size },
    money,
    winRate: trips.length === 0 ? null : trips.filter((trip) => trip.net > 0).length / trips.length,
    drawdown: { usdc: worst, pctOfAccount: worst > 0 && valueAtPeak !== null && valueAtPeak > 0 ? (worst / valueAtPeak) * 100 : null },
    holdMin: holds.length === 0 ? null : { p10: quantile(holds, 0.1), median: quantile(holds, 0.5), p90: quantile(holds, 0.9) },
    stake: trips.length === 0 ? null : { medianUsdc: median(trips.map((trip) => trip.entryNotional)) },
    leverage: known.length === 0 ? null : { median: median(known), max: Math.max(...known), trips: known.length },
    ledger: {
      deposits: ledger.filter((update) => inSpan(update) && update.type === 'deposit').reduce((total, update) => total + (update.usdc ?? 0), 0),
      withdrawals: -ledger.filter((update) => inSpan(update) && update.type === 'withdraw').reduce((total, update) => total + (update.usdc ?? 0), 0)
    },
    coins: [...coins.values()].sort((a, b) => b.trips - a.trips || a.coin.localeCompare(b.coin)),
    open: { positions: state?.positions ?? [], unrealized: (state?.positions ?? []).reduce((total, position) => total + position.unrealizedPnl, 0), accountValue: state?.accountValue ?? null }
  }
}
