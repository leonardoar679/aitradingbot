import measured from './hypotheses-2026.json'
import { HYPOTHESES, HYPOTHESES_VERSION, HYPOTHESIS_HORIZONS, type HypothesisFigures } from './hypotheses'

// THE USER'S DIRECTION HYPOTHESES AS MEASURED ON A YEAR (V7.2-R Stage 6, 22 October 2026): what research/hypotheses.ts
// found on the year archive (October 2025 to September 2026, each month's 40 pairs by the month before's volume), shipped
// as data for the Forecast Lab to show beside the registered verdicts (V72R-S6-GAINERS and the rest). The forecast reads
// nothing from it: no rule passed its line, and the way stays NEUTRAL. IT IS DATA.

export interface HypothesesFile {
  version: string
  /** The months measured, the moment the year was halved at, and what the catalyst rule read. */
  months: string[]
  split: number
  catalyst: string
  figures: HypothesisFigures[]
}

/** The shipped file, read whole; null where it is of another version or not whole. */
export function parseHypothesesFile(value: unknown): HypothesesFile | null {
  if (typeof value !== 'object' || value === null) return null
  const file = value as Partial<HypothesesFile>
  if (file.version !== HYPOTHESES_VERSION || !Array.isArray(file.months) || typeof file.split !== 'number' || typeof file.catalyst !== 'string' || !Array.isArray(file.figures)) return null
  const whole = file.figures.every(
    (entry) => (HYPOTHESES as readonly string[]).includes(entry?.hypothesis) && (HYPOTHESIS_HORIZONS as readonly string[]).includes(entry?.horizon) && typeof entry.calls === 'number' && Array.isArray(entry.lines)
  )
  return whole ? (file as HypothesesFile) : null
}

/** The year's figures as measured; null where the shipped file cannot be read. */
export const HYPOTHESES_MEASURED: HypothesesFile | null = parseHypothesesFile(measured)
