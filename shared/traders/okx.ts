import type { FundingRate } from './delay'
import type { OpenPosition } from './hyperliquid'
import type { RoundTrip } from './roundTrips'

// AN OKX LEAD TRADER'S RECORD, READ (V8 Stage 7, 27 October 2026). OKX publishes a lead trader's copy-trading positions
// without a key: each position closed over the last three months -- its instrument, side, leverage, average opening and
// closing prices and times, its size in contracts, its margin and OKX's own figure of its profit -- the positions open
// now, which a trader may hide, and the trader's profit day by day over a year. OKX gives no fee. Its profit figure is
// REPORTED, as OKX states it; beside it the app ESTIMATES each position's own -- its move on its size, less OKX's taker
// fee each way and the funding OKX published for the instrument over its hold. Only USDT-margined perpetuals are read.
// Pure: the main process fetches (electron/services/okxClient.ts).

export const OKX_HOST = 'https://www.okx.com'

export const OKX_LINES = {
  /** OKX's rates for a regular user (Lv1) on its perpetual swaps, in percent. The estimate charges the taker's each way:
   * an upper bound where the trader's orders rested on the book. */
  fees: {
    makerPct: 0.02,
    takerPct: 0.05,
    readOn: '2026-10-27',
    source: "OKX's regular-user (Lv1) rates for perpetual swaps as third-party reviews give them; OKX's own fee page renders by script and was not read"
  },
  /** Closed positions are read 100 a page, newest first: OKX keeps three months of them. */
  historyPage: 100,
  maxHistoryPages: 30,
  currentPage: 100,
  /** An instrument's funding history is read 100 a page back from now, to the record's first opening. */
  fundingPage: 100,
  maxFundingPages: 24
} as const

export interface OkxInstrument {
  instId: string
  /** What one contract is worth, in the coin. */
  ctVal: number
}

/** A position the trader closed, as OKX reported it, with the app's estimate beside it. */
export interface OkxPosition {
  subPosId: string
  instId: string
  /** The instrument's coin: BTC of BTC-USDT-SWAP. */
  coin: string
  side: 'long' | 'short'
  lever: number | null
  mgnMode: string
  openAvgPx: number
  openTimeMs: number
  closeAvgPx: number
  closeTimeMs: number
  /** Its size in contracts, and in the coin where the contract's value is known. */
  contracts: number
  qty: number | null
  margin: number | null
  /** OKX's own figure of its profit in USDT, and as a share of its margin: REPORTED. */
  pnl: number
  pnlRatio: number | null
  /** The app's estimate in USDT: its move on its size, OKX's taker fee each way, and the funding OKX published over
   * its hold (null where no funding history reaches it) -- ESTIMATED; null where the contract's value is not known. */
  estimate: { grossUsdt: number; feesUsdt: number; fundingUsdt: number | null; netUsdt: number } | null
  label: 'REPORTED'
}

/** A day of the trader's profit over a year, as OKX reports it: cumulative, in USDT and as a share. */
export interface OkxPnlPoint {
  timeMs: number
  pnl: number
  pnlRatio: number | null
}

export interface OkxStats {
  winRatio: number | null
  profitDays: number | null
  lossDays: number | null
  investAmt: number | null
  avgSubPosNotional: number | null
  curCopyTraderPnl: number | null
}

/** What the trader holds now: the positions OKX shows, and how many it hides. */
export interface OkxOpen {
  atMs: number
  positions: OpenPosition[]
  hidden: number
  unrealized: number
}

const num = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}
const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/** The coin of a USDT-margined perpetual's id; null for any other instrument. */
export function okxCoinOf(instId: unknown): string | null {
  if (typeof instId !== 'string') return null
  const match = /^([A-Z0-9]+)-USDT-SWAP$/.exec(instId)
  return match === null ? null : match[1]
}

/** The USDT-margined perpetuals' contract values, from OKX's list of instruments. */
export function okxInstrumentsOf(raw: unknown): Map<string, OkxInstrument> {
  const out = new Map<string, OkxInstrument>()
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = record(item)
    const ctVal = num(entry?.ctVal)
    if (entry === null || okxCoinOf(entry.instId) === null || entry.ctType !== 'linear' || entry.settleCcy !== 'USDT' || ctVal === null || !(ctVal > 0)) continue
    out.set(entry.instId as string, { instId: entry.instId as string, ctVal })
  }
  return out
}

/** An instrument's funding rates as OKX published them, oldest first. */
export function okxFundingOf(raw: unknown): FundingRate[] {
  const rates = new Map<number, number>()
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = record(item)
    const timeMs = num(entry?.fundingTime)
    const rate = num(entry?.realizedRate) ?? num(entry?.fundingRate)
    if (timeMs === null || rate === null) continue
    rates.set(Math.floor(timeMs / 1000), rate)
  }
  return [...rates.entries()].map(([timeSec, rate]) => ({ timeSec, rate })).sort((a, b) => a.timeSec - b.timeSec)
}

/** The app's estimate of a position: its move on its size, the taker fee each way, and the funding over its hold. */
export function okxEstimateOf(position: Pick<OkxPosition, 'side' | 'openAvgPx' | 'closeAvgPx' | 'openTimeMs' | 'closeTimeMs'>, qty: number, rates: readonly FundingRate[] | undefined, lines: typeof OKX_LINES = OKX_LINES): NonNullable<OkxPosition['estimate']> {
  const sign = position.side === 'long' ? 1 : -1
  const grossUsdt = sign * (position.closeAvgPx - position.openAvgPx) * qty
  const feesUsdt = (lines.fees.takerPct / 100) * qty * (position.openAvgPx + position.closeAvgPx)
  const fromSec = position.openTimeMs / 1000
  const toSec = position.closeTimeMs / 1000
  // Funding is known only where OKX's published history reaches the hold: a long pays a positive rate on its value.
  let fundingUsdt: number | null = null
  if (rates !== undefined && rates.length > 0 && rates[0].timeSec <= fromSec + 8 * 3600) {
    fundingUsdt = 0
    for (const rate of rates) if (rate.timeSec > fromSec && rate.timeSec <= toSec) fundingUsdt -= sign * rate.rate * qty * position.openAvgPx
  }
  return { grossUsdt, feesUsdt, fundingUsdt, netUsdt: grossUsdt - feesUsdt + (fundingUsdt ?? 0) }
}

/** A closed position read, its estimate made from the instruments and the funding histories; null for one not in its
 * shape or not a USDT-margined perpetual's. */
export function okxPositionOf(raw: unknown, instruments: ReadonlyMap<string, OkxInstrument>, funding: ReadonlyMap<string, readonly FundingRate[]>, lines: typeof OKX_LINES = OKX_LINES): OkxPosition | null {
  const entry = record(raw)
  if (entry === null) return null
  const coin = okxCoinOf(entry.instId)
  const openAvgPx = num(entry.openAvgPx)
  const closeAvgPx = num(entry.closeAvgPx)
  const openTimeMs = num(entry.openTime)
  const closeTimeMs = num(entry.closeTime)
  const contractsSigned = num(entry.subPos)
  const pnl = num(entry.pnl)
  if (coin === null || typeof entry.subPosId !== 'string' || entry.subPosId === '') return null
  if (openAvgPx === null || !(openAvgPx > 0) || closeAvgPx === null || !(closeAvgPx > 0) || openTimeMs === null || closeTimeMs === null || closeTimeMs < openTimeMs) return null
  if (contractsSigned === null || contractsSigned === 0 || pnl === null) return null
  const side = entry.posSide === 'long' ? 'long' : entry.posSide === 'short' ? 'short' : entry.posSide === 'net' ? (contractsSigned > 0 ? 'long' : 'short') : null
  if (side === null) return null
  const contracts = Math.abs(contractsSigned)
  const instrument = instruments.get(entry.instId as string)
  const qty = instrument === undefined ? null : contracts * instrument.ctVal
  const base = { side, openAvgPx, closeAvgPx, openTimeMs, closeTimeMs } as const
  return {
    subPosId: entry.subPosId,
    instId: entry.instId as string,
    coin,
    ...base,
    lever: num(entry.lever),
    mgnMode: typeof entry.mgnMode === 'string' ? entry.mgnMode : '',
    contracts,
    qty,
    margin: num(entry.margin),
    pnl,
    pnlRatio: num(entry.pnlRatio),
    estimate: qty === null ? null : okxEstimateOf(base, qty, funding.get(entry.instId as string), lines),
    label: 'REPORTED'
  }
}

/** A position as a round trip, its figures the app's estimate; null without one. */
export function okxTripOf(position: OkxPosition): RoundTrip | null {
  if (position.qty === null || position.estimate === null) return null
  const sign = position.side === 'long' ? 1 : -1
  return {
    coin: position.coin,
    side: position.side,
    openedAtMs: position.openTimeMs,
    closedAtMs: position.closeTimeMs,
    entryPx: position.openAvgPx,
    exitPx: position.closeAvgPx,
    maxSize: position.qty,
    entryNotional: position.qty * position.openAvgPx,
    realizedPnl: position.estimate.grossUsdt,
    fees: position.estimate.feesUsdt,
    rebates: 0,
    funding: position.estimate.fundingUsdt ?? 0,
    net: position.estimate.netUsdt,
    movePct: sign * (position.closeAvgPx / position.openAvgPx - 1) * 100,
    fills: 2,
    reportedPnl: position.pnl,
    ...(position.lever !== null ? { lever: position.lever } : {})
  }
}

/** The positions open now: those OKX shows, read like Hyperliquid's, and how many it hides (a trader may hide their
 * instruments and sizes). */
export function okxOpenOf(raw: unknown, instruments: ReadonlyMap<string, OkxInstrument>, atMs: number): OkxOpen {
  const positions: OpenPosition[] = []
  let hidden = 0
  let unrealized = 0
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = record(item)
    if (entry === null) continue
    const upl = num(entry.upl)
    if (upl !== null) unrealized += upl
    const coin = okxCoinOf(entry.instId)
    const contracts = num(entry.subPos)
    const openAvgPx = num(entry.openAvgPx)
    const instrument = coin === null ? undefined : instruments.get(entry.instId as string)
    if (coin === null || contracts === null || contracts === 0 || openAvgPx === null || !(openAvgPx > 0) || instrument === undefined) {
      hidden++
      continue
    }
    const qty = Math.abs(contracts) * instrument.ctVal
    const short = entry.posSide === 'short' || (entry.posSide === 'net' && contracts < 0)
    const lever = num(entry.lever)
    positions.push({
      coin,
      size: short ? -qty : qty,
      entryPx: openAvgPx,
      positionValue: qty * (num(entry.markPx) ?? openAvgPx),
      unrealizedPnl: upl ?? 0,
      leverage: lever === null ? null : { type: typeof entry.mgnMode === 'string' ? entry.mgnMode : '', value: lever },
      liquidationPx: null,
      marginUsed: num(entry.margin) ?? 0,
      fundingSinceOpen: null
    })
  }
  return { atMs, positions, hidden, unrealized }
}

/** The trader's profit day by day over a year, oldest first. */
export function okxPnlSeriesOf(raw: unknown): OkxPnlPoint[] {
  const out: OkxPnlPoint[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = record(item)
    const timeMs = num(entry?.beginTs)
    const pnl = num(entry?.pnl)
    if (timeMs === null || pnl === null) continue
    out.push({ timeMs, pnl, pnlRatio: num(entry?.pnlRatio) })
  }
  return out.sort((a, b) => a.timeMs - b.timeMs)
}

/** The trader's figures over a year, as OKX reports them. */
export function okxStatsOf(raw: unknown): OkxStats | null {
  const entry = record(Array.isArray(raw) ? raw[0] : raw)
  if (entry === null) return null
  return {
    winRatio: num(entry.winRatio),
    profitDays: num(entry.profitDays),
    lossDays: num(entry.lossDays),
    investAmt: num(entry.investAmt),
    avgSubPosNotional: num(entry.avgSubPosNotional),
    curCopyTraderPnl: num(entry.curCopyTraderPnl)
  }
}
