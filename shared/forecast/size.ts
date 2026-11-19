import { QUANTILE_LEVELS } from './ml/quantile'

// THE SIZE OF THE MOVE A FORECAST EXPECTS (V10 Stage 2, 19 November 2026). The person asked how much of the predicted move
// happened. A forecast that knows no way says a middle near no move -- 0.01% to 0.03% where coins move 2% to 5% a day --
// and that middle is not what it knows. What it knows is the size: the move it expects either way, the mean of the
// move's absolute value under its five levels. Read off them as a line through P10, P25, P50, P75 and P90, the tails
// carried on by the outer two slopes, at 200 even steps of the chance. For a normal move this reads about 5% under the
// true mean size (the straight tails fall short of a normal's); on the seven-day run of 9-16 November 2026 the real
// moves came to 1.06, 1.00, 0.99, 0.97 and 0.91 times it at five minutes, fifteen, an hour, four hours and a day.

export const SIZE_VERSION = 'size-v1'

const STEPS = 200

/** A forecast's level at chance `p`: between its levels on the line through them, beyond them on the outer slopes. */
export function levelAt(quantiles: readonly number[], p: number): number {
  const levels = QUANTILE_LEVELS
  const last = levels.length - 1
  if (p <= levels[0]) return quantiles[0] - ((levels[0] - p) / (levels[1] - levels[0])) * (quantiles[1] - quantiles[0])
  if (p >= levels[last]) return quantiles[last] + ((p - levels[last]) / (levels[last] - levels[last - 1])) * (quantiles[last] - quantiles[last - 1])
  for (let k = 0; k < last; k++) {
    if (p <= levels[k + 1]) return quantiles[k] + ((p - levels[k]) / (levels[k + 1] - levels[k])) * (quantiles[k + 1] - quantiles[k])
  }
  return quantiles[last]
}

/** The move a forecast expects either way: the mean absolute value of its levels over the chances, in the levels' own
 * unit (percent where they are percent). NaN for levels that are not five finite numbers. */
export function expectedMove(quantiles: readonly number[]): number {
  if (quantiles.length !== QUANTILE_LEVELS.length || !quantiles.every(Number.isFinite)) return Number.NaN
  let sum = 0
  for (let step = 0; step < STEPS; step++) sum += Math.abs(levelAt(quantiles, (step + 0.5) / STEPS))
  return sum / STEPS
}
