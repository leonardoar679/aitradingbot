import { DIRECTION_LINES } from './direction'

// HOW GOOD A FORECAST IS (the V6 document, §31; V6 Stage 9, 13 October 2026): one score from 0 to
// 100, from seven readings, each by fixed lines, and the forecast's PredictionQuality as their
// weighted mean -- a reading that cannot be had (no story, no call) left out of it rather than counted
// as nothing.
// - direction: how far its P(up) is from an even chance, full at 15 points -- and nothing where its
//   direction was not skilful on weeks it was not fitted on (shared/forecast/direction.ts);
// - range: how narrow its 80% range is against its class's usual one, full at three quarters of it,
//   nothing at twice;
// - calibration: how near its 80% range came to holding 80% on the weeks it was tested on, nothing
//   ten points away;
// - news: the strength of the story moving it -- its impact and novelty, halved without a library
//   behind it -- and nothing where it goes against the forecast's way; left out without a story;
// - market confirmation: whether the coin's last hour and the market's breadth go its way; left out
//   where it calls no way;
// - model agreement: how close the weighing models' medians are, nothing at three tenths of the
//   range's half-width apart;
// - data freshness: full within a minute of the close it was read at, nothing at five.
// Without a skilful direction no forecast reaches 75, the line STRONG needs.

export const QUALITY_VERSION = 'quality-v1'

export const QUALITY_LINES = {
  weights: { direction: 0.25, range: 0.15, calibration: 0.15, news: 0.1, confirmation: 0.15, agreement: 0.1, freshness: 0.1 },
  directionFull: 0.15,
  rangeFull: 0.75,
  rangeNone: 2,
  coverageNone: 0.1,
  agreementNone: 0.3,
  freshFullSec: 60,
  freshNoneSec: 300
} as const

export interface QualityInput {
  pUp: number
  directionSkill: number | null
  width80Pct: number
  usualWidth80Pct: number
  /** The 80% range's coverage on the weeks it was tested on. */
  coverage80: number
  /** The weighing models' spread of medians over the range's half-width. */
  disagreement: number
  /** The story moving the forecast, where one does. */
  news: { impact: number; novelty: number; fromLibrary: boolean; shiftPct: number } | null
  /** The coin's last hour in units of its usual move, and the share of pairs that rose in it. */
  market: { z1h: number; breadth1h: number } | null
  /** Seconds from the close the forecast was read at to when it was made. */
  ageSec: number
}

export interface PredictionQuality {
  score: number
  parts: { direction: number; range: number; calibration: number; news: number | null; confirmation: number | null; agreement: number; freshness: number }
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)

export function qualityOf(input: QualityInput): PredictionQuality {
  const lines = QUALITY_LINES
  const skilful = input.directionSkill !== null && input.directionSkill >= DIRECTION_LINES.minDirectionSkill
  const lean = Math.sign(input.pUp - 0.5)
  const direction = skilful ? 100 * clamp01(Math.abs(input.pUp - 0.5) / lines.directionFull) : 0
  const ratio = input.usualWidth80Pct > 0 ? input.width80Pct / input.usualWidth80Pct : Number.NaN
  const range = Number.isFinite(ratio) ? 100 * clamp01((lines.rangeNone - ratio) / (lines.rangeNone - lines.rangeFull)) : 50
  const calibration = 100 * clamp01(1 - Math.abs(input.coverage80 - 0.8) / lines.coverageNone)
  let news: number | null = null
  if (input.news !== null) {
    const against = skilful && lean !== 0 && input.news.shiftPct !== 0 && Math.sign(input.news.shiftPct) !== lean
    news = against ? 0 : 100 * clamp01((input.news.impact / 100) * input.news.novelty * (input.news.fromLibrary ? 1 : 0.5))
  }
  let confirmation: number | null = null
  if (skilful && lean !== 0 && input.market !== null) {
    confirmation = 100 * clamp01((50 + 30 * Math.tanh(lean * input.market.z1h) + 20 * lean * (2 * input.market.breadth1h - 1)) / 100)
  }
  const agreement = 100 * clamp01(1 - input.disagreement / lines.agreementNone)
  const freshness = 100 * clamp01(1 - (input.ageSec - lines.freshFullSec) / (lines.freshNoneSec - lines.freshFullSec))
  const parts = { direction, range, calibration, news, confirmation, agreement, freshness }
  let total = 0
  let weight = 0
  for (const [key, value] of Object.entries(parts) as [keyof typeof parts, number | null][]) {
    if (value === null) continue
    total += lines.weights[key] * value
    weight += lines.weights[key]
  }
  return { score: Math.round(weight > 0 ? total / weight : 0), parts }
}
