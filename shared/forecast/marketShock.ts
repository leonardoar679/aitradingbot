import { FEATURE_NAMES, quickAt, type PairSeries } from './features'
import type { Panel } from './panel'
import { SHOCK_LINES, crossFittedFactors, pastShockLine, scoreShock, shockFor, shockRuleFrom, stretchShock, type ShockRow, type ShockRule, type ShockScore } from './shock'
import { usualMove } from './targets'

// THE MARKET'S SHOCK STATES (V7.1 Stage 11, 16 October 2026). V6.1's rule (shared/forecast/shock.ts)
// widens every range after one thing: Bitcoin's last fifteen minutes past 2.5 of its usual moves. A
// market has more states than calm and that. Six are told apart here, from what is known at the
// moment and nothing after it, each a word on every forecast (recorded with it):
//
//   NORMAL             none of the below.
//   PRE_EVENT          a scheduled release within the hour (Stage 12 brings the calendar; none before it).
//   POST_EVENT_SHOCK   Bitcoin's last fifteen minutes at or past the line (V6.1's moment), the forty-five
//                      minutes before them not themselves a trend: a break.
//   TRENDING_SHOCK     the same sharp fifteen minutes with the forty-five minutes before them already at or
//                      past 2.5 of their usual moves the same way: the move continues rather than breaks.
//   LIQUIDATION_SHOCK  a sharp fall (btc15 at or under minus the line) with the breadth of the last
//                      fifteen minutes at or under a fifth and the market's volume at three times its
//                      usual fifteen minutes or more: a cascade, not a repricing.
//   RECOVERY           within four hours after any shock, no shock now, Bitcoin's hour at least one usual
//                      move against the shock's way.
//
// A shock moment is Bitcoin's fifteen minutes past the line, read from its bars alone at every five-minute
// close, so that the recovery window is the same in training and live; the forty-five minutes before are
// read from its hour's and its fifteen minutes' figures (btcBeforeOf), nothing new. The lines are fixed
// here before anything is measured by them, and pinned under the engine's constants (shared/appConfig.ts).
//
// THE RULES BY STATE: at each refit, every state but NORMAL gets a widening of its own, fitted and judged
// exactly as V6.1's (shockRuleFrom: factors for the outer and the inner pair, cross-fitted by week, adopted
// where the 80% range comes nearer 80% and the pinball loss is no worse). Then the horizon chooses, by the
// same figures on every row either would touch, between V6.1's one rule and the states' rules -- both
// widening as fitted on the other weeks -- and takes the one with the lower pinball loss; neither, where
// neither passed its own test. The models are refitted on the v2 features at the same refit, which see the
// same moves (btc_r_15m, eth_r_15m, btc_acc_15m, breadth_15m, market_vol_acc): "none" is then the models
// alone, shock-aware, and the rules are judged on what they still add.
//
// IT IS ARITHMETIC. No key, no model of anyone else's, no order.

export const MARKET_SHOCK_VERSION = 'market-shock-v1'

export const MARKET_SHOCK_STATES = ['NORMAL', 'PRE_EVENT', 'POST_EVENT_SHOCK', 'TRENDING_SHOCK', 'LIQUIDATION_SHOCK', 'RECOVERY'] as const
export type MarketShockState = (typeof MARKET_SHOCK_STATES)[number]
/** The states a widening is fitted for: every one but NORMAL, which is never touched. */
export const WIDENED_STATES: readonly MarketShockState[] = MARKET_SHOCK_STATES.filter((state) => state !== 'NORMAL')
/** How a state is written into a record's byte: its index; a moment whose state could not be read. */
export const STATE_UNKNOWN = 255

export const MARKET_SHOCK_LINES = {
  /** |btc15| at or past which a moment is a shock: V6.1's line. */
  line: SHOCK_LINES.line,
  /** The forty-five minutes before the sharp fifteen, in their usual moves, at or past which the same way
   * the shock is TRENDING. */
  trendLine: 2.5,
  /** A LIQUIDATION_SHOCK: btc15 at or under minus the line, the breadth of the last fifteen minutes at or
   * under this share, and the market's fifteen minutes' volume at or over this many times its usual. */
  liquidationBreadth: 0.2,
  liquidationVolume: 3,
  /** RECOVERY: within this many hours after a shock, Bitcoin's hour at least this many usual moves against it. */
  recoveryHours: 4,
  recoveryLine: 1,
  /** PRE_EVENT: within this many minutes before a scheduled release (Stage 12). */
  preEventMinutes: 60
} as const

/** Bitcoin at a moment: its last fifteen minutes and its hour, each in its usual moves (its own z_15m and
 * z_1h figures, shared/forecast/features.ts). */
export interface BtcReading {
  t: number
  btc15: number
  btc1h: number
}

/** The market at a moment: Bitcoin's reading, the share of pairs up over the last fifteen minutes, and the
 * market's fifteen minutes' volume against its usual. */
export interface MarketReading extends BtcReading {
  breadth15: number
  volAcc15: number
}

/** A shock moment and its way. */
export interface ShockMoment {
  t: number
  way: 1 | -1
}

/** The way of the shock at a moment -- Bitcoin's fifteen minutes at or past the line, either way -- and 0
 * where there is none. */
export function shockWayOf(reading: Pick<BtcReading, 'btc15'>): 1 | -1 | 0 {
  const { btc15 } = reading
  if (!Number.isFinite(btc15) || Math.abs(btc15) < MARKET_SHOCK_LINES.line) return 0
  return btc15 > 0 ? 1 : -1
}

/** The forty-five minutes before the last fifteen, in their usual moves, from the hour's and the fifteen
 * minutes' figures: the hour's move less the fifteen minutes', over the usual move of nine bars (a usual
 * move grows with the square root of the bars, shared/forecast/targets.ts). */
export function btcBeforeOf(reading: Pick<BtcReading, 'btc15' | 'btc1h'>): number {
  return reading.btc1h * Math.sqrt(12 / 9) - reading.btc15 * Math.sqrt(3 / 9)
}

/** The shock moments of a timeline of Bitcoin's readings, oldest first. */
export function shockMomentsOf(timeline: readonly BtcReading[]): ShockMoment[] {
  const out: ShockMoment[] = []
  for (const reading of timeline) {
    const way = shockWayOf(reading)
    if (way !== 0) out.push({ t: reading.t, way })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** The latest shock moment before `tSec` within the recovery window; null where there is none. */
export function latestShockBefore(moments: readonly ShockMoment[], tSec: number): ShockMoment | null {
  const from = tSec - MARKET_SHOCK_LINES.recoveryHours * 3600
  let found: ShockMoment | null = null
  for (const moment of moments) {
    if (moment.t >= tSec) break
    if (moment.t >= from) found = moment
  }
  return found
}

/** The market's state at a moment from its reading and the shock moments before it. */
export function marketShockStateOf(now: MarketReading, moments: readonly ShockMoment[], options: { preEvent?: boolean } = {}): MarketShockState {
  if (shockWayOf(now) !== 0) {
    if (now.btc15 <= -MARKET_SHOCK_LINES.line && now.breadth15 <= MARKET_SHOCK_LINES.liquidationBreadth && now.volAcc15 >= MARKET_SHOCK_LINES.liquidationVolume) return 'LIQUIDATION_SHOCK'
    const before = btcBeforeOf(now)
    if (Number.isFinite(before) && Math.abs(before) >= MARKET_SHOCK_LINES.trendLine && before * now.btc15 > 0) return 'TRENDING_SHOCK'
    return 'POST_EVENT_SHOCK'
  }
  if (options.preEvent === true) return 'PRE_EVENT'
  const last = latestShockBefore(moments, now.t)
  if (last !== null && Number.isFinite(now.btc1h) && now.btc1h * last.way < 0 && Math.abs(now.btc1h) >= MARKET_SHOCK_LINES.recoveryLine) return 'RECOVERY'
  return 'NORMAL'
}

/** Bitcoin's reading at a close from its bars: the same figures as its row's z_15m and z_1h (quickAt reads
 * the day's volatility as the row does). Null where it has no quick read at the moment. */
export function btcReadingAt(series: PairSeries, tSec: number): BtcReading | null {
  const quick = quickAt(series, tSec)
  if (quick === null) return null
  const usual15 = usualMove(quick.rv24h, 3)
  const usual1h = usualMove(quick.rv24h, 12)
  if (!(usual15 > 0) || !(usual1h > 0)) return null
  return { t: tSec, btc15: quick.r15m / usual15, btc1h: quick.r1h / usual1h }
}

/** Bitcoin's readings at every five-minute close from `fromSec` to `toSec`, oldest first. */
export function btcTimelineOf(series: PairSeries, fromSec: number, toSec: number): BtcReading[] {
  const out: BtcReading[] = []
  for (let t = Math.ceil(fromSec / 300) * 300; t <= toSec; t += 300) {
    const reading = btcReadingAt(series, t)
    if (reading !== null) out.push(reading)
  }
  return out
}

const Z15 = FEATURE_NAMES.indexOf('z_15m')
const Z1H = FEATURE_NAMES.indexOf('z_1h')
const BREADTH15 = FEATURE_NAMES.indexOf('breadth_15m')
const VOL_ACC = FEATURE_NAMES.indexOf('market_vol_acc')

/** The market's state at each moment of a panel, read from Bitcoin's row there (its own figures and the
 * cross-section's) and the shock moments of Bitcoin's timeline; a moment without Bitcoin's row is not in it. */
export function marketShockByTime(panel: Pick<Panel, 'rows' | 'cols' | 'x' | 'time' | 'pair' | 'symbols'>, moments: readonly ShockMoment[], preEventAt?: (tSec: number) => boolean): Map<number, MarketShockState> {
  const out = new Map<number, MarketShockState>()
  const btc = panel.symbols.indexOf('BTCUSDT')
  if (btc < 0) return out
  for (let row = 0; row < panel.rows; row++) {
    if (panel.pair[row] !== btc) continue
    const t = panel.time[row]
    const at = row * panel.cols
    const now: MarketReading = { t, btc15: panel.x[at + Z15], btc1h: panel.x[at + Z1H], breadth15: panel.x[at + BREADTH15], volAcc15: panel.x[at + VOL_ACC] }
    out.set(t, marketShockStateOf(now, moments, { preEvent: preEventAt?.(t) === true }))
  }
  return out
}

// THE RULES BY STATE.

/** A walk forward's row as the rules read it: V6.1's row with the market's state at its moment. */
export interface MarketShockRow extends ShockRow {
  state: MarketShockState
}

/** Which widening a horizon uses: none, V6.1's one rule past the line, or the states' rules. */
export type ShockWidening = 'none' | 'line' | 'states'

export interface MarketShockRules {
  version: string
  /** Each state's rule, fitted on the record's rows in it; absent where the record held none of them. */
  byState: Partial<Record<MarketShockState, ShockRule>>
  /** On every row the line's rule or a state's would widen, cross-fitted: as forecast, by the line's rule
   * (where adopted), and by the states' rules (those adopted). Null where there is no such row. */
  compared: { rows: number; before: ShockScore; line: ShockScore; states: ShockScore } | null
  chosen: ShockWidening
}

/** Which widening to use: of those that passed their own test, the one with the lower pinball loss on every
 * row either would touch; the line's on a tie, as the simpler. */
export function chooseWidening(input: { lineAdopted: boolean; statesAdopted: boolean; line: ShockScore; states: ShockScore }): ShockWidening {
  if (input.lineAdopted && input.statesAdopted) return input.states.pinball < input.line.pinball ? 'states' : 'line'
  if (input.lineAdopted) return 'line'
  if (input.statesAdopted) return 'states'
  return 'none'
}

/** A horizon's rules by state from its walk forward's rows, and its choice against V6.1's rule `line`
 * (fitted on the same rows past the line). */
export function marketShockRulesOf(rows: readonly MarketShockRow[], line: ShockRule): MarketShockRules {
  const byState: MarketShockRules['byState'] = {}
  const factorsOf = new Map<MarketShockState, Map<number, { k80: number; k50: number }>>()
  for (const state of WIDENED_STATES) {
    const mine = rows.filter((row) => row.state === state)
    if (mine.length === 0) continue
    const rule = shockRuleFrom(mine)
    byState[state] = rule
    if (rule.adopted) factorsOf.set(state, crossFittedFactors(mine))
  }
  const union = rows.filter((row) => pastShockLine(row) || row.state !== 'NORMAL')
  if (union.length === 0) return { version: MARKET_SHOCK_VERSION, byState, compared: null, chosen: 'none' }
  const lineFactors = line.adopted ? crossFittedFactors(rows.filter(pastShockLine)) : null
  const widen = (row: ShockRow, factors: { k80: number; k50: number } | undefined): { z: number; q: readonly number[] } => (factors === undefined ? row : { z: row.z, q: stretchShock(row.q, factors.k80, factors.k50) })
  const before = scoreShock(union)
  const byLine = scoreShock(union.map((row) => widen(row, lineFactors !== null && pastShockLine(row) ? lineFactors.get(row.week) : undefined)))
  const byStates = scoreShock(union.map((row) => widen(row, factorsOf.get(row.state)?.get(row.week))))
  const chosen = chooseWidening({ lineAdopted: line.adopted, statesAdopted: factorsOf.size > 0, line: byLine, states: byStates })
  return { version: MARKET_SHOCK_VERSION, byState, compared: { rows: union.length, before, line: byLine, states: byStates }, chosen }
}

/** A walk forward without the states on record: the line's rule decides, as before Stage 11. */
export function noMarketShockRecord(): MarketShockRules {
  return { version: MARKET_SHOCK_VERSION, byState: {}, compared: null, chosen: 'line' }
}

/** What widens a range at a moment: the state's adopted rule where the horizon chose the states', V6.1's
 * where it chose the line (or holds no choice, from before Stage 11), nothing otherwise. */
export function marketWidening(entry: { shock?: ShockRule; marketShock?: MarketShockRules }, btc15: number | null | undefined, state: MarketShockState | null | undefined): { k80: number; k50: number; held: { before: number; after: number } | null; state: MarketShockState | null } | null {
  const held = (rule: ShockRule): { before: number; after: number } | null => (rule.before !== null && rule.after !== null ? { before: rule.before.in80, after: rule.after.in80 } : null)
  const chosen = entry.marketShock?.chosen ?? 'line'
  if (chosen === 'none') return null
  if (chosen === 'states') {
    const rule = state === null || state === undefined ? undefined : entry.marketShock?.byState[state]
    if (rule === undefined || !rule.adopted) return null
    return { k80: rule.k80, k50: rule.k50, held: held(rule), state: state as MarketShockState }
  }
  const factors = shockFor(entry.shock, btc15)
  return factors === null ? null : { ...factors, held: held(entry.shock!), state: null }
}
