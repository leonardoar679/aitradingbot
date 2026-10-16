import impact from './event-impact-2026.json'
import type { MacroKind } from './macro'
import type { MarketRegime } from '../marketResearch'

// THE EVENT IMPACT HISTORY (V7.1 Stage 12, 16 October 2026): what Bitcoin did after each scheduled release
// inside the bars a profile held, measured by research/eventImpact.ts and shipped as data. The forecast
// reads nothing from it: a kind's figures are shown on the Forecast Lab, said to be too few under thirty
// releases (EVENT_IMPACT_LINES.minSamples), and the surprise of a release is read live as the market's own
// reaction (shared/forecast/marketShock.ts, POST_EVENT_SHOCK). IT IS DATA.

export const EVENT_IMPACT_VERSION = 'event-impact-v1'

export const EVENT_IMPACT_LINES = {
  /** Releases of a kind before its figures are more than a sketch. */
  minSamples: 30
} as const

export const IMPACT_WINDOWS = ['m5', 'm15', 'h1', 'h4'] as const
export type ImpactWindow = (typeof IMPACT_WINDOWS)[number]

export interface EventImpactRow {
  kind: MacroKind
  at: number
  date: string
  regime: MarketRegime
  /** Bitcoin's move from the close before the release, in percent and in its usual moves, at each window. */
  movePct: Record<ImpactWindow, number>
  z: Record<ImpactWindow, number>
  /** The highest and lowest the path went within four hours, in percent from that close. */
  maxUpPct: number
  maxDownPct: number
  /** Minutes after the release when the path first touched one usual hourly move up, and down; null where
   * not within four hours. */
  touchUpMin: number | null
  touchDownMin: number | null
  /** Whether the fifteen minutes after were a shock by the forecast's line. */
  shockAfter: boolean
}

export interface EventImpactKind {
  n: number
  enough: boolean
  medianAbsPct: Record<ImpactWindow, number | null>
  medianAbsZ: Record<ImpactWindow, number | null>
  medianMaxUpPct: number | null
  medianMaxDownPct: number | null
  shockAfterShare: number | null
  touchedWithin4hShare: number | null
  medianTouchMin: number | null
  byRegime: Record<string, number>
}

export interface EventImpactFile {
  version: string
  madeAt: string
  source: { pair: string; fromSec: number; toSec: number; bars: number }
  minSamples: number
  kinds: Record<MacroKind, EventImpactKind>
  events: EventImpactRow[]
}

const FILE = impact as EventImpactFile

/** The shipped history; null where the file is not of this version. */
export const EVENT_IMPACT: EventImpactFile | null = FILE.version === EVENT_IMPACT_VERSION ? FILE : null
