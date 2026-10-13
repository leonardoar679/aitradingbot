import { HORIZON_BARS, type Horizon } from './features'

// THE NEWS IN THE FORECAST (the V6 document, §18-24, §54-55 and §58; V6 Stage 8, 13 October 2026).
// The models forecast from the market alone. A story about a coin then moves its forecast -- the
// "+news" (V3) and "+news +AI" (V4) of §49 -- by fixed rules over what the app had seen of it at the
// moment of the forecast, never after (§54): a story counts from when the app SAW it, and an analyst's
// reading from when it was answered.
//
// WHICH STORIES. Those naming the coin as their subject (DIRECT), seen in the four hours before the
// forecast; of them, the one that moves it most.
//
// HOW MUCH (V3). The reaction library (shared/newsFeed.ts) holds, for each kind of news, the median
// move after a story of that kind, from the close of the minute it was published in, at a minute, five,
// fifteen, an hour and four hours -- shown, and used here, only from thirty stories (§22). Read as a
// path, it says what is still to come: for a story published `age` seconds before the forecast, the
// median path's move from `age` to `age` plus the horizon. That is the shift of the forecast's
// median, scaled by the story's impact (0 to 100), its novelty (§20: new news counts whole, a story
// carried again half, old news nothing) and by whether the market had already moved its way before it
// was published (priced in: nothing). The kind's spread -- half the distance between the median best
// and worst moves within an hour, or four -- widens the range, scaled the same way, as a variance
// added. A kind without thirty stories moves no median: it only widens, by up to half the forecast's
// own spread again.
//
// THE AI (V4). Where the news analyst read the story -- asked live, when the story came, so that its
// reading holds only what was known then (§55) -- its reading stands for the rules': its direction for
// the library's sign, its impact for the rule's, its "priced in" for the reaction's, and a story it
// read as not about this coin moves nothing. Nothing new is asked.

export const NEWS_EFFECT_VERSION = 'news-effect-v1'

export const NEWS_EFFECT_LINES = {
  /** Stories seen this long before the forecast, or less, move it. */
  windowSec: 4 * 3600,
  /** A kind's median path is read from this many stories. */
  minStories: 30,
  /** A story carried again counts this much. */
  repeatNovelty: 0.5,
  /** A kind without its library widens the range by up to this share of the forecast's own spread. */
  noHistoryWiden: 0.5,
  /** The news-moved forecasts' P(up) is measured over this many days of their outcomes, from this many
   * at a horizon. */
  skillDays: 30,
  skillMinOutcomes: 200
} as const

/** A story as the forecast reads it: what the news feed made of it, with its reaction's verdict on
 * whether the market had moved its way before it was published. */
export interface NewsStoryInput {
  id: string
  title: string
  source: string
  kind: string
  impact: number
  /** Unix seconds. */
  publishedAt: number
  seenAt: number
  stale: boolean
  repeat: boolean
  relationship: 'DIRECT' | 'INDIRECT'
  pricedIn: boolean
}

/** The news analyst's reading of a story, and when it was answered. */
export interface AnalystReadingInput {
  ticker: string | null
  relationship: 'DIRECT' | 'INDIRECT' | 'NONE'
  direction: 'up' | 'down' | 'none'
  impact: number
  pricedIn: boolean
  /** Unix seconds. */
  at: number
}

/** A kind of news's reactions, as the library holds them. */
export interface KindReactions {
  eventType: string
  enough: boolean
  medianPct: { m1?: number | null; m5: number | null; m15: number | null; h1: number | null; h4: number | null } | null
  excursions: { best1hPct: number | null; worst1hPct: number | null; best4hPct: number | null; worst4hPct: number | null } | null
}

export interface NewsEffect {
  variant: 'v3' | 'v4'
  storyId: string
  title: string
  source: string
  kind: string
  /** The impact used: the rule's for V3, the analyst's for V4. */
  impact: number
  /** Seconds since it was published, at the forecast. */
  ageSec: number
  novelty: number
  pricedIn: boolean
  /** Whether its kind had thirty stories to read a path from. */
  fromLibrary: boolean
  /** The median moved by, in percent; and the range widened by, in percent as one standard deviation
   * (from the library), or as a share of the forecast's own spread (without it). */
  shiftPct: number
  widenPct: number
  widenShare: number
}

/** The median path of a kind of news: its move at `t` seconds after publication, straight between
 * the library's points, flat beyond four hours. */
export function medianPathAt(median: NonNullable<KindReactions['medianPct']>, t: number): number {
  const points: [number, number][] = [[0, 0]]
  const add = (at: number, value: number | null | undefined): void => {
    if (typeof value === 'number' && Number.isFinite(value)) points.push([at, value])
  }
  add(60, median.m1)
  add(300, median.m5)
  add(900, median.m15)
  add(3600, median.h1)
  add(14_400, median.h4)
  if (t <= 0) return 0
  for (let k = 1; k < points.length; k++) {
    const [t1, v1] = points[k]
    if (t <= t1) {
      const [t0, v0] = points[k - 1]
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)
    }
  }
  return points[points.length - 1][1]
}

/** Half the spread of a kind's moves within an hour (or four, for the longer horizons), scaled to the
 * horizon by the square root of time; null where the library has none. */
function spreadPct(excursions: KindReactions['excursions'], horizonSec: number): number | null {
  if (excursions === null) return null
  const hour = horizonSec <= 3600
  const best = hour ? excursions.best1hPct : excursions.best4hPct
  const worst = hour ? excursions.worst1hPct : excursions.worst4hPct
  if (best === null || worst === null) return null
  const window = hour ? 3600 : 14_400
  return ((best - worst) / 2) * Math.sqrt(Math.min(horizonSec, window) / window)
}

export function noveltyOf(story: Pick<NewsStoryInput, 'stale' | 'repeat'>): number {
  return story.stale ? 0 : story.repeat ? NEWS_EFFECT_LINES.repeatNovelty : 1
}

/** How far the news-moved forecasts' P(up) beat what knows nothing -- an even chance, and the share of
 * their outcomes that went up, whichever scored better -- on their own outcomes of the last days, by
 * horizon; null at a horizon with fewer than its least. */
export function newsSkillOf(outcomes: readonly { h: Horizon; due: number; pUp: number; up: boolean }[], nowSec: number): Partial<Record<Horizon, number | null>> {
  const out: Partial<Record<Horizon, number | null>> = {}
  const since = nowSec - NEWS_EFFECT_LINES.skillDays * 86_400
  for (const horizon of Object.keys(HORIZON_BARS) as Horizon[]) {
    const rows = outcomes.filter((row) => row.h === horizon && row.due >= since)
    if (rows.length < NEWS_EFFECT_LINES.skillMinOutcomes) {
      out[horizon] = null
      continue
    }
    const share = rows.filter((row) => row.up).length / rows.length
    const brier = rows.reduce((sum, row) => sum + (row.pUp - (row.up ? 1 : 0)) ** 2, 0) / rows.length
    const reference = Math.min(0.25, rows.reduce((sum, row) => sum + (share - (row.up ? 1 : 0)) ** 2, 0) / rows.length)
    out[horizon] = reference > 0 ? 1 - brier / reference : null
  }
  return out
}

/** What one story does to a coin's forecast at a horizon, for a variant; null where it does nothing. */
export function storyEffect(input: {
  variant: 'v3' | 'v4'
  story: NewsStoryInput
  ticker: string
  horizon: Horizon
  nowSec: number
  library: readonly KindReactions[]
  reading?: AnalystReadingInput | null
}): NewsEffect | null {
  const { story } = input
  if (story.relationship !== 'DIRECT' || story.seenAt > input.nowSec || input.nowSec - story.seenAt > NEWS_EFFECT_LINES.windowSec) return null
  const novelty = noveltyOf(story)
  if (novelty === 0) return null
  // The analyst's reading, where it was answered by the forecast's moment, stands for the rules'.
  const reading = input.variant === 'v4' && input.reading !== null && input.reading !== undefined && input.reading.at <= input.nowSec ? input.reading : null
  if (reading !== null && (reading.relationship === 'NONE' || reading.ticker !== input.ticker)) return null
  const impact = reading?.impact ?? story.impact
  const pricedIn = reading?.pricedIn ?? story.pricedIn
  const kind = input.library.find((entry) => entry.eventType === story.kind)
  // The library withholds a kind's medians below its thirty stories (shared/newsFeed.ts impactByType).
  const fromLibrary = kind !== undefined && kind.medianPct !== null
  const horizonSec = HORIZON_BARS[input.horizon] * 300
  const age = Math.max(0, input.nowSec - story.publishedAt)
  const scale = (impact / 100) * novelty
  let shiftPct = 0
  if (fromLibrary && !pricedIn) {
    const toCome = medianPathAt(kind.medianPct!, age + horizonSec) - medianPathAt(kind.medianPct!, age)
    // The rules take the library's own sign; the analyst's reading, its direction, at the library's size.
    const way = reading === null ? null : reading.direction === 'up' ? 1 : reading.direction === 'down' ? -1 : 0
    shiftPct = (way === null ? toCome : way * Math.abs(toCome)) * scale
  }
  const spread = fromLibrary ? spreadPct(kind.excursions, horizonSec) : null
  return {
    variant: input.variant,
    storyId: story.id,
    title: story.title,
    source: story.source,
    kind: story.kind,
    impact,
    ageSec: age,
    novelty,
    pricedIn,
    fromLibrary,
    shiftPct,
    widenPct: spread === null ? 0 : spread * scale,
    widenShare: fromLibrary && spread !== null ? 0 : NEWS_EFFECT_LINES.noHistoryWiden * scale
  }
}

/** The story that moves a coin's forecast most at a horizon, for a variant: the largest shift, then
 * the widest. Null where no story moves it. */
export function newsEffectOf(input: {
  variant: 'v3' | 'v4'
  stories: readonly NewsStoryInput[]
  ticker: string
  horizon: Horizon
  nowSec: number
  library: readonly KindReactions[]
  readings?: Readonly<Record<string, AnalystReadingInput>>
}): NewsEffect | null {
  let best: NewsEffect | null = null
  for (const story of input.stories) {
    const effect = storyEffect({ variant: input.variant, story, ticker: input.ticker, horizon: input.horizon, nowSec: input.nowSec, library: input.library, reading: input.readings?.[story.id] ?? null })
    if (effect === null) continue
    const weight = (entry: NewsEffect): [number, number] => [Math.abs(entry.shiftPct), entry.widenPct + entry.widenShare]
    if (best === null) best = effect
    else {
      const [s, w] = weight(effect)
      const [bs, bw] = weight(best)
      if (s > bs || (s === bs && w > bw)) best = effect
    }
  }
  return best
}
