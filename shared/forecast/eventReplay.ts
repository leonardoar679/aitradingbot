import type { MacroEvent, MacroKind } from '../calendar/macro'
import { DIRECTION_LINES } from './direction'
import { MARKET_SHOCK_STATES, marketShockRulesOf, type MarketShockRow, type MarketShockState } from './marketShock'
import { crossFittedFactors, pastShockLine, scoreShock, shockRuleOf, stretchShock, type ShockScore } from './shock'

// A SCHEDULED RELEASE REPLAYED ON THE WALK FORWARD (V7.1 Stage 12, 16 October 2026). For each release of
// the macro calendar inside the weeks a walk forward tested, the record's hour before it (the last hour
// strictly before the release) and the first hour at or after it, every pair together: how the 80% and
// 50% ranges held and the pinball loss, as forecast (V2, the forecast shown, scored out of sample --
// V6), widened by V6.1's rule on the rows past the line (its factors from the other weeks alone), and
// widened by the states' rules where the record keeps the states (the same way); the market's state the
// record holds at the hour; Bitcoin's fifteen minutes there, the surprise as the market read it; and the
// shown P(up)'s calls at the forecast's lines and how many were right (the direction source). The
// shock-aware size is the record's own ranges on a run fitted on the features-v2 rows: on an older run
// "as forecast" is the models from before, and the page says so. Every figure out of sample: nothing a
// row is judged by was fitted on its week.
//
// The 14 October 2026 CPI (12:30 UTC) is the release this was built for: its hour before is 12:00, its
// first hour after 13:00.

export const EVENT_REPLAY_VERSION = 'event-replay-v1'

/** A tested hour as the replay reads it: V6.1's row with its pair, its state where known, and the shown
 * P(up) where the row was scored for it. */
export interface EventReplayInput extends Omit<MarketShockRow, 'state'> {
  pair: string
  state?: MarketShockState
  pUp: number | null
}

export interface EventReplayRow {
  kind: MacroKind
  name: string
  /** The release's moment, and the record's hour read: before it or the first at or after it. */
  at: number
  hour: 'before' | 'after'
  t: number
  /** Pairs at the hour. */
  n: number
  asForecast: ShockScore
  /** Widened by the line's rule (null where the walk forward refused it) and by the states' rules (null where
   * the record holds no states, or none of their rules was adopted). */
  byLine: ShockScore | null
  byStates: ShockScore | null
  /** The market's state at the hour as most rows hold it; null where the record holds none. */
  state: MarketShockState | null
  /** Bitcoin's fifteen minutes at the hour, in its usual moves; null where not on record. */
  btc15: number | null
  /** The shown P(up)'s calls at the forecast's lines, and of those whose move was not nought, the right. */
  calls: number
  callsRight: number
}

/** The record's hours a release is read at: the last strictly before it, the first at or after it. */
export function releaseHours(at: number): { before: number; after: number } {
  return { before: Math.floor((at - 1) / 3600) * 3600, after: Math.ceil(at / 3600) * 3600 }
}

function callsOf(rows: readonly EventReplayInput[]): { calls: number; callsRight: number } {
  let calls = 0
  let right = 0
  for (const row of rows) {
    if (row.pUp === null || !Number.isFinite(row.pUp)) continue
    const way = row.pUp >= DIRECTION_LINES.bullish ? 1 : row.pUp <= 1 - DIRECTION_LINES.bullish ? -1 : 0
    if (way === 0) continue
    calls++
    if (row.z * way > 0) right++
  }
  return { calls, callsRight: right }
}

function stateOf(rows: readonly EventReplayInput[]): MarketShockState | null {
  const counts = new Map<MarketShockState, number>()
  for (const row of rows) if (row.state !== undefined) counts.set(row.state, (counts.get(row.state) ?? 0) + 1)
  let best: MarketShockState | null = null
  for (const state of MARKET_SHOCK_STATES) {
    const count = counts.get(state) ?? 0
    if (count > 0 && (best === null || count > (counts.get(best) ?? 0))) best = state
  }
  return best
}

/** Each release inside the rows' span, at its hour before and its first hour after, from the whole record's
 * rows (the rules are fitted on every week, each week's factors from the others). */
export function eventReplayOf(rows: readonly EventReplayInput[], events: readonly MacroEvent[]): EventReplayRow[] {
  if (rows.length === 0) return []
  const hours = new Map<number, EventReplayInput[]>()
  for (const row of rows) {
    const mine = hours.get(row.t)
    if (mine === undefined) hours.set(row.t, [row])
    else mine.push(row)
  }
  const line = shockRuleOf(rows)
  const lineFactors = line.adopted ? crossFittedFactors(rows.filter(pastShockLine)) : null
  const withState = rows.filter((row): row is EventReplayInput & { state: MarketShockState } => row.state !== undefined)
  const states = withState.length === 0 ? null : marketShockRulesOf(withState, line)
  const stateFactors = new Map<MarketShockState, Map<number, { k80: number; k50: number }>>()
  if (states !== null) {
    for (const [state, rule] of Object.entries(states.byState) as [MarketShockState, (typeof states.byState)[MarketShockState]][]) {
      if (rule?.adopted) stateFactors.set(state, crossFittedFactors(withState.filter((row) => row.state === state)))
    }
  }
  const out: EventReplayRow[] = []
  for (const event of events) {
    // A release outside the tested weeks has no row at either hour, and is not here.
    const at = releaseHours(event.at)
    for (const hour of ['before', 'after'] as const) {
      const t = at[hour]
      const mine = hours.get(t)
      if (mine === undefined || mine.length === 0) continue
      const asForecast = scoreShock(mine)
      const byLine = lineFactors === null ? null : scoreShock(mine.map((row) => (pastShockLine(row) ? { z: row.z, q: stretchShock(row.q, lineFactors.get(row.week)!.k80, lineFactors.get(row.week)!.k50) } : row)))
      const byStates =
        stateFactors.size === 0
          ? null
          : scoreShock(
              mine.map((row) => {
                const factors = row.state === undefined ? undefined : stateFactors.get(row.state)?.get(row.week)
                return factors === undefined ? row : { z: row.z, q: stretchShock(row.q, factors.k80, factors.k50) }
              })
            )
      const btc = mine.find((row) => Number.isFinite(row.btc15))
      out.push({ kind: event.kind, name: event.name, at: event.at, hour, t, n: mine.length, asForecast, byLine, byStates, state: stateOf(mine), btc15: btc === undefined ? null : btc.btc15, ...callsOf(mine) })
    }
  }
  return out
}
