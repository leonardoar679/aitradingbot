import type { ForecastBar } from './bars'
import { FEATURE_NAMES, endsAt, quickAt, type PairQuick, type PairSeries } from './features'
import type { Panel } from './panel'
import { usualMove } from './targets'

// NEW INFORMATION FOR THE WAY, AS BLOCKS OF FIGURES (V7.2-R Stage 7, 22 October 2026; the V7.2 draft's Stages 9-10). No
// model of the way has beaten the base rate on the figures the forecast reads (features-v2), so three blocks of figures
// it does not read are put to the test, each fitted beside the 68 it does on identical folds and kept only where the
// walk forward finds the forecast better for it (research/blockAblation.ts):
// - CROSS, where the coin stands among the others: its moves less Bitcoin's share of them over fifteen minutes, four
//   hours and a day (idio_1h is read already; the draft's btc_gap_15m is idio_15m with its sign turned, so it is not
//   read twice), its rank among the month's pairs over the hour and the day, how far the pairs' last fifteen minutes
//   spread, and the share of them that moved two usual moves;
// - FLOW, who pressed and how: the share of the volume market buyers took over five and fifteen minutes and its change
//   from the hour, the trades' pace over fifteen minutes against the hour's, the size of a trade over fifteen minutes
//   against the day's, and Bitcoin's and the market's buyers;
// - POSITIONING, the futures market's crowd (Binance's public archive): the funding rate, the premium and its change, the
//   open interest's change over fifteen minutes and an hour and with the price's way, the account and top-trader
//   long/short ratios against their week, the perpetual's buyers -- read only from rows stamped ten minutes or more
//   before the moment (the archive's rows appear minutes after their five minutes end, POSITIONING.md), changes and
//   deviations alone (a level that persists from training into a tested week would fingerprint the calendar), and a
//   pair without a perpetual read as neutral with has_perp 0.
// The columns are appended to a research panel's rows; the forecast's own figures and its models are untouched until a
// block passes its registered line. Arithmetic on bars and public archives: no key, no model, no order.

export const BLOCKS_V3_VERSION = 'blocks-v3'

export const CROSS_NAMES = ['idio_15m', 'idio_4h', 'idio_24h', 'xs_rank_1h', 'xs_rank_24h', 'xs_disp_15m', 'shock_breadth_15m'] as const
export const FLOW_NAMES = ['taker_5m', 'taker_15m', 'taker_acc', 'trades_acc_15m', 'size_15m', 'btc_taker_15m', 'market_taker_15m'] as const
export const POSITIONING_NAMES = ['funding_last', 'premium_1h', 'premium_chg_1h', 'oi_chg_15m', 'oi_chg_1h', 'oi_x_price', 'lsr_acc_dev', 'lsr_top_dev', 'perp_taker_15m', 'has_perp'] as const
export const BLOCKS_V3 = ['cross', 'flow', 'positioning'] as const
export type BlockV3 = (typeof BLOCKS_V3)[number]
export const BLOCK_NAMES: Record<BlockV3, readonly string[]> = { cross: CROSS_NAMES, flow: FLOW_NAMES, positioning: POSITIONING_NAMES }

export const BLOCKS_V3_LINES = {
  /** A move of this many usual fifteen minutes or more is a shock, for the breadth of them. */
  shockUsual: 2,
  /** How long before a moment a positioning row must be stamped to be read at it, and how stale the last may be. */
  positioningLagSec: 600,
  positioningStaleSec: 1800,
  /** The week a ratio's deviation is read against. */
  ratioWeekSec: 7 * 86_400
} as const

const BETA = FEATURE_NAMES.indexOf('beta_btc')
const BAR = 300

/** A pair's figures read at a moment from its five-minute bars: its moves over 3, 48 and 288 bars, its buyers' share
 * over 1, 3 and 12, its trades' pace and its trades' size; null without a whole day of bars before the moment. */
interface PairFlow {
  r15m: number
  r4h: number
  r24h: number
  r1h: number
  z15m: number
  taker5m: number
  taker15m: number
  taker1h: number
  tradesAcc15m: number
  size15m: number
}

const takerOf = (bars: readonly ForecastBar[], from: number, to: number): number => {
  let taker = 0
  let volume = 0
  for (let at = from; at < to; at++) {
    taker += bars[at].takerBuyVolume
    volume += bars[at].volume
  }
  return volume > 0 ? taker / volume - 0.5 : 0
}

function pairFlowAt(series: PairSeries, quick: PairQuick, tSec: number): PairFlow | null {
  const m5 = series.m5
  const n = endsAt(series, tSec).m5
  if (n < 289) return null
  const usual15 = usualMove(quick.rv24h, 3)
  let trades15 = 0
  let trades1h = 0
  let quote15 = 0
  let quote24 = 0
  let trades24 = 0
  for (let at = n - 288; at < n; at++) {
    const bar = m5[at]
    quote24 += bar.quoteVolume
    trades24 += bar.trades
    if (at >= n - 12) trades1h += bar.trades
    if (at >= n - 3) {
      trades15 += bar.trades
      quote15 += bar.quoteVolume
    }
  }
  const pace = trades1h > 0 && trades15 > 0 ? Math.log(trades15 / 3 / (trades1h / 12)) : 0
  const size = trades15 > 0 && trades24 > 0 && quote24 > 0 && quote15 > 0 ? Math.log(quote15 / trades15 / (quote24 / trades24)) : 0
  return {
    r15m: quick.r15m,
    r1h: quick.r1h,
    r4h: quick.r4h,
    r24h: quick.r24h,
    z15m: usual15 > 0 ? quick.r15m / usual15 : 0,
    taker5m: takerOf(m5, n - 1, n),
    taker15m: takerOf(m5, n - 3, n),
    taker1h: takerOf(m5, n - 12, n),
    tradesAcc15m: pace,
    size15m: size
  }
}

/** A pair's futures positioning on file (research/fetch-positioning.mjs), each series oldest first: the five-minute
 * metrics [time, openInterest, openInterestValue, topAccountRatio, topPositionRatio, accountRatio, takerRatio], the
 * premium index's five-minute bars [openTime, open, high, low, close] and the funding rates [time, rate, hours]. */
export interface PairPositioning {
  metrics: readonly (readonly (number | null)[])[]
  premium: readonly (readonly (number | null)[])[]
  funding: readonly (readonly (number | null)[])[]
}

/** The index past the last row stamped at or before `time`. */
function upTo(rows: readonly (readonly (number | null)[])[], time: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((rows[middle][0] as number) <= time) low = middle + 1
    else high = middle
  }
  return low
}

/** The row stamped at `time` exactly, or null. */
function rowAt(rows: readonly (readonly (number | null)[])[], time: number): readonly (number | null)[] | null {
  const at = upTo(rows, time) - 1
  return at >= 0 && rows[at][0] === time ? rows[at] : null
}

const lnOf = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.log(value) : null)

/** POSITIONING at a moment: the readings from rows stamped ten minutes or more before it; null where the last such row
 * is older than half an hour (no perpetual, or a hole), when the block is read as neutral with has_perp 0. */
export function positioningAt(data: PairPositioning, tSec: number, r1h: number): number[] | null {
  const L = BLOCKS_V3_LINES
  const cut = tSec - L.positioningLagSec
  const end = upTo(data.metrics, cut)
  if (end === 0) return null
  const last = data.metrics[end - 1]
  const lastAt = last[0] as number
  if (cut - lastAt > L.positioningStaleSec) return null
  const oi = lnOf(last[1])
  const oi15 = lnOf(rowAt(data.metrics, lastAt - 900)?.[1])
  const oi1h = lnOf(rowAt(data.metrics, lastAt - 3600)?.[1])
  const oiChg15 = oi !== null && oi15 !== null ? oi - oi15 : 0
  const oiChg1h = oi !== null && oi1h !== null ? oi - oi1h : 0
  // A ratio against its own week, in logs: how far the crowd leans now against how it has leaned.
  const deviation = (column: number): number => {
    const now = lnOf(last[column])
    if (now === null) return 0
    const from = upTo(data.metrics, lastAt - L.ratioWeekSec)
    let sum = 0
    let n = 0
    for (let at = from; at < end; at++) {
      const value = lnOf(data.metrics[at][column])
      if (value === null) continue
      sum += value
      n++
    }
    return n === 0 ? 0 : now - sum / n
  }
  let taker = 0
  let takers = 0
  for (let at = Math.max(0, end - 3); at < end; at++) {
    const value = lnOf(data.metrics[at][6])
    if (value === null) continue
    taker += value
    takers++
  }
  // The premium's bars closed by the cut: its hour's mean, and its change over the hour.
  const premiumEnd = upTo(data.premium, cut - BAR)
  let premiumMean = 0
  let premiumChange = 0
  if (premiumEnd >= 13) {
    let sum = 0
    for (let at = premiumEnd - 12; at < premiumEnd; at++) sum += (data.premium[at][4] ?? 0) as number
    premiumMean = sum / 12
    premiumChange = ((data.premium[premiumEnd - 1][4] ?? 0) as number) - ((data.premium[premiumEnd - 13][4] ?? 0) as number)
  }
  const fundingEnd = upTo(data.funding, tSec)
  const funding = fundingEnd === 0 ? 0 : ((data.funding[fundingEnd - 1][1] ?? 0) as number)
  return [funding, premiumMean, premiumChange, oiChg15, oiChg1h, oiChg1h * Math.sign(r1h), deviation(5), deviation(4), takers === 0 ? 0 : taker / takers, 1]
}

/** A research panel widened by the blocks named: every row's own figures, then each block's columns in order. A block's
 * figure that cannot be read at a row is 0, its neutral; the rows are the panel's own, so a widened walk forward tests on
 * the same rows as the panel's. `positioning` holds each pair's archive, where read. */
export function widenPanel(panel: Panel, market: ReadonlyMap<string, PairSeries>, blocks: readonly BlockV3[], positioning: ReadonlyMap<string, PairPositioning> = new Map()): Panel {
  const names = blocks.flatMap((block) => BLOCK_NAMES[block])
  const cols = panel.cols + names.length
  const x = new Float32Array(panel.rows * cols)
  for (let row = 0; row < panel.rows; row++) x.set(panel.x.subarray(row * panel.cols, (row + 1) * panel.cols), row * cols)
  // The rows of each moment, for the figures the pairs share at it.
  const byTime = new Map<number, number[]>()
  for (let row = 0; row < panel.rows; row++) {
    const mine = byTime.get(panel.time[row])
    if (mine === undefined) byTime.set(panel.time[row], [row])
    else mine.push(row)
  }
  for (const [t, rows] of byTime) {
    const flows = new Map<number, PairFlow>()
    for (const row of rows) {
      const symbol = panel.symbols[panel.pair[row]]
      const series = market.get(symbol)
      if (series === undefined) continue
      const quick = quickAt(series, t)
      if (quick === null) continue
      const flow = pairFlowAt(series, quick, t)
      if (flow !== null) flows.set(row, flow)
    }
    const all = [...flows.values()]
    const rank = (pick: (flow: PairFlow) => number, value: number): number => (all.length <= 1 ? 0.5 : all.filter((other) => pick(other) < value).length / (all.length - 1))
    const z15 = all.map((flow) => flow.z15m)
    const meanZ = z15.reduce((sum, value) => sum + value, 0) / Math.max(1, z15.length)
    const dispersion = z15.length < 2 ? 0 : Math.sqrt(z15.reduce((sum, value) => sum + (value - meanZ) ** 2, 0) / (z15.length - 1))
    const shocked = z15.length === 0 ? 0 : z15.filter((value) => Math.abs(value) >= BLOCKS_V3_LINES.shockUsual).length / z15.length
    const marketTaker = all.length === 0 ? 0 : all.reduce((sum, flow) => sum + flow.taker15m, 0) / all.length
    const btcRow = rows.find((row) => panel.symbols[panel.pair[row]] === 'BTCUSDT')
    const btc = btcRow === undefined ? undefined : flows.get(btcRow)
    for (const row of rows) {
      const flow = flows.get(row)
      const out: number[] = []
      for (const block of blocks) {
        if (block === 'cross') {
          if (flow === undefined || btc === undefined) out.push(...CROSS_NAMES.map(() => 0))
          else {
            const beta = panel.x[row * panel.cols + BETA]
            const rv = panel.rv24h[row]
            const idio = (own: number, theirs: number, bars: number): number => {
              const usual = usualMove(rv, bars)
              return usual > 0 ? (own - beta * theirs) / usual : 0
            }
            out.push(idio(flow.r15m, btc.r15m, 3), idio(flow.r4h, btc.r4h, 48), idio(flow.r24h, btc.r24h, 288), rank((other) => other.r1h, flow.r1h), rank((other) => other.r24h, flow.r24h), dispersion, shocked)
          }
        } else if (block === 'flow') {
          if (flow === undefined) out.push(...FLOW_NAMES.map(() => 0))
          else out.push(flow.taker5m, flow.taker15m, flow.taker15m - flow.taker1h, flow.tradesAcc15m, flow.size15m, btc?.taker15m ?? 0, marketTaker)
        } else {
          const data = positioning.get(panel.symbols[panel.pair[row]])
          const read = data === undefined ? null : positioningAt(data, t, flow?.r1h ?? 0)
          out.push(...(read ?? POSITIONING_NAMES.map(() => 0)))
        }
      }
      for (let k = 0; k < out.length; k++) x[row * cols + panel.cols + k] = Number.isFinite(out[k]) ? out[k] : 0
    }
  }
  return { ...panel, cols, x }
}

/** The block's columns of a widened panel shuffled across its rows, the rest left as they are: the permuted control,
 * which keeps each column's spread and breaks its tie to the row. Deterministic from the seed. */
export function permuteColumns(panel: Panel, from: number, seed: number): Panel {
  const x = Float32Array.from(panel.x)
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
  const order = Array.from({ length: panel.rows }, (_, row) => row)
  for (let at = order.length - 1; at > 0; at--) {
    const other = Math.floor(next() * (at + 1))
    ;[order[at], order[other]] = [order[other], order[at]]
  }
  for (let row = 0; row < panel.rows; row++) {
    const source = order[row]
    for (let col = from; col < panel.cols; col++) x[row * panel.cols + col] = panel.x[source * panel.cols + col]
  }
  return { ...panel, x }
}
