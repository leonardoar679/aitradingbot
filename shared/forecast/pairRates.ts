import { barsOfText, mergeBars, type ForecastBar } from './bars'
import { dayMoveRatesOf, type DayMoveRates } from './bigMovers'
import { bigDaysOf, dayBarsOf, type BigDays } from './btcDay'
import { moveRatesOf, type MoveRates } from './moveRates'

// A PAIR'S NINETY DAYS, READ AWAY FROM THE MAIN THREAD (V8 Stage 10, 2 November 2026). The live forecast holds three
// days of a pair's five-minute bars, and its ninety-day move rates (shared/forecast/moveRates.ts) and day moves of 5%
// and 10% (shared/forecast/bigMovers.ts) need thirty days of hours at the least: read from those three days, both came
// out empty from V7.2-R on. So once an hour each pair's files are read as they are kept and handed to a worker (task
// pairRates), which reads the bars as the data service does and works both out at the hour's close.

/** A pair's rates at a moment, and how many bars they were read from. */
export interface PairRates {
  bars: number
  moveRates: MoveRates | null
  dayMoves: DayMoveRates | null
  /** Its big UTC days over the last 90 (V9 Stage 1; shared/forecast/btcDay.ts): what Home's Bitcoin tile says. */
  bigDays: BigDays | null
}

/** A pair's rates at `atSec` from its files' texts, oldest month first: each file read as the data service reads it,
 * the months merged, a bar read twice kept once. */
export function pairRatesOf(texts: readonly string[], atSec: number): PairRates {
  let bars: ForecastBar[] = []
  for (const text of texts) bars = mergeBars(bars, barsOfText(text))
  return { bars: bars.length, moveRates: moveRatesOf(bars, atSec), dayMoves: dayMoveRatesOf(bars, atSec), bigDays: bigDaysOf(dayBarsOf(bars), atSec) }
}
