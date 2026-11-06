import { HORIZON_BARS, type Horizon } from './features'
import type { ForecastBar } from './bars'

// HOW OFTEN A COIN MOVES ENOUGH TO PAY FOR A TRADE (V7.2-R Stage 3, 20 October 2026). The chances a forecast
// gives a move of 1% or 2% either way failed their registered line on both records read (V72R-S3-ODDS): the
// forecast calls no way, and in a falling week it said rises as often as falls. Until a reading of the size
// alone passes on records not yet read (V72R-S3-EITHER), the card says what is known without a model: how often
// this coin's own price, over its last ninety days, closed an hour, four hours and a day on at least 1%, 2% and
// 5% up or down, and touched 1% and 2% on the way, and how long the first such touch typically took. A frequency
// of the past, said as such, is not a forecast; it is what a trade's target and stop are set against.
//
// Read from the five-minute bars the forecast already keeps (forecastData/), at every hour's close in the window
// (so a day weighs twenty-four moments), where the bars a horizon on are all on file. Arithmetic on the bars: no
// key, no model, no order.

export const MOVE_RATES_VERSION = 'move-rates-v2'

export const MOVE_RATES_LINES = {
  horizons: ['hour1', 'hours4', 'hours24'] as readonly Horizon[],
  /** The moves a close is counted at, and the moves a touch is, in percent: 3%, 4% and 5% touches since V9 Stage 1 (6
   * November 2026), so Home can say how soon a big mover's move came, and Bitcoin's 4%. */
  closeMovesPct: [1, 2, 5] as readonly number[],
  touchMovesPct: [1, 2, 3, 4, 5] as readonly number[],
  /** The days of bars read, back from the moment. */
  days: 90,
  /** A moment every this many five-minute bars: every hour's close. */
  stepBars: 12,
  /** The moments a horizon needs for its rates to be said: thirty days of hours. */
  minMoments: 30 * 24
} as const

const BAR_SEC = 300

/** At a move, the share of moments whose close was at least that far up, down, and either. */
export interface CloseRate {
  pct: number
  up: number
  down: number
  either: number
}

/** At a move, the share of moments whose path touched it up, down and either way, and the typical minutes to
 * the first touch either way among the moments that touched. */
export interface TouchRate {
  pct: number
  up: number
  down: number
  either: number
  medianMinutes: number | null
}

export interface HorizonRates {
  horizon: Horizon
  moments: number
  close: CloseRate[]
  touch: TouchRate[]
}

export interface MoveRates {
  version: string
  /** Unix seconds: the first and last moment read. */
  fromSec: number
  toSec: number
  days: number
  horizons: HorizonRates[]
}

/** The median of a list of numbers; null for none. */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** A coin's rates from its five-minute bars (oldest first, each by its open time), over the MOVE_RATES_LINES
 * window back from `atSec` (a bar's close); a horizon short of its moments is left out, and null is returned
 * where none has enough. */
export function moveRatesOf(bars: readonly ForecastBar[], atSec: number): MoveRates | null {
  const fromSec = atSec - MOVE_RATES_LINES.days * 86_400
  // The bars that had closed by the moment, in the span read.
  let start = 0
  while (start < bars.length && bars[start].time + BAR_SEC <= fromSec) start++
  let end = bars.length
  while (end > start && bars[end - 1].time + BAR_SEC > atSec) end--
  const spans = MOVE_RATES_LINES.horizons.map((horizon) => HORIZON_BARS[horizon])
  const closeMoves = MOVE_RATES_LINES.closeMovesPct
  const touchMoves = MOVE_RATES_LINES.touchMovesPct
  const tallies = spans.map(() => ({
    moments: 0,
    first: Number.POSITIVE_INFINITY,
    last: Number.NEGATIVE_INFINITY,
    closeUp: closeMoves.map(() => 0),
    closeDown: closeMoves.map(() => 0),
    touchUp: touchMoves.map(() => 0),
    touchDown: touchMoves.map(() => 0),
    touchEither: touchMoves.map(() => 0),
    minutes: touchMoves.map((): number[] => [])
  }))
  const above = touchMoves.map(() => 0)
  const below = touchMoves.map(() => 0)
  const upAt = touchMoves.map(() => 0)
  const downAt = touchMoves.map(() => 0)
  for (let at = start; at < end; at++) {
    // A moment at every hour's close: the bar that closes on the hour.
    const closeSec = bars[at].time + BAR_SEC
    if (closeSec % (MOVE_RATES_LINES.stepBars * BAR_SEC) !== 0) continue
    const price = bars[at].close
    if (!(price > 0)) continue
    // The horizons read at this moment: the bar a horizon on has closed by the moment, and every bar between is on
    // file (a run of five-minute bars as long in time as in count). A longer one read means every shorter one is.
    let longest = -1
    for (let k = 0; k < spans.length; k++) if (at + spans[k] < end && bars[at + spans[k]].time - bars[at].time === spans[k] * BAR_SEC) longest = k
    if (longest < 0) continue
    touchMoves.forEach((pct, k) => {
      above[k] = price * (1 + pct / 100)
      below[k] = price * (1 - pct / 100)
      upAt[k] = 0
      downAt[k] = 0
    })
    // One walk along the path for every horizon: each is tallied as the walk reaches its last bar.
    let next = 0
    for (let step = 1; step <= spans[longest]; step++) {
      const bar = bars[at + step]
      for (let k = 0; k < touchMoves.length; k++) {
        if (upAt[k] === 0 && bar.high >= above[k]) upAt[k] = step
        if (downAt[k] === 0 && bar.low <= below[k]) downAt[k] = step
      }
      while (next <= longest && spans[next] === step) {
        const tally = tallies[next]
        tally.moments++
        tally.first = Math.min(tally.first, closeSec)
        tally.last = Math.max(tally.last, closeSec)
        const movePct = (bar.close / price - 1) * 100
        closeMoves.forEach((pct, k) => {
          if (movePct >= pct) tally.closeUp[k]++
          if (movePct <= -pct) tally.closeDown[k]++
        })
        for (let k = 0; k < touchMoves.length; k++) {
          if (upAt[k] > 0) tally.touchUp[k]++
          if (downAt[k] > 0) tally.touchDown[k]++
          if (upAt[k] > 0 || downAt[k] > 0) {
            tally.touchEither[k]++
            const firstStep = upAt[k] === 0 ? downAt[k] : downAt[k] === 0 ? upAt[k] : Math.min(upAt[k], downAt[k])
            tally.minutes[k].push(firstStep * 5)
          }
        }
        next++
      }
    }
  }
  const horizons: HorizonRates[] = []
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  MOVE_RATES_LINES.horizons.forEach((horizon, index) => {
    const tally = tallies[index]
    const moments = tally.moments
    if (moments < MOVE_RATES_LINES.minMoments) return
    first = Math.min(first, tally.first)
    last = Math.max(last, tally.last)
    horizons.push({
      horizon,
      moments,
      close: closeMoves.map((pct, k) => ({ pct, up: tally.closeUp[k] / moments, down: tally.closeDown[k] / moments, either: (tally.closeUp[k] + tally.closeDown[k]) / moments })),
      touch: touchMoves.map((pct, k) => ({ pct, up: tally.touchUp[k] / moments, down: tally.touchDown[k] / moments, either: tally.touchEither[k] / moments, medianMinutes: medianOf(tally.minutes[k]) }))
    })
  })
  if (horizons.length === 0) return null
  return { version: MOVE_RATES_VERSION, fromSec: first, toSec: last, days: MOVE_RATES_LINES.days, horizons }
}

/** A horizon's rates, where the coin has them. */
export function ratesAt(rates: MoveRates | null | undefined, horizon: Horizon): HorizonRates | null {
  return rates?.horizons.find((entry) => entry.horizon === horizon) ?? null
}
