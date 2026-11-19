import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { AI_ADDITION_PROMPT_VERSIONS, AI_DAILY_LINES, validateDailyDirection, type DailyDirectionQuestion } from '../../shared/aiAdditions'
import { SOURCE_RECORD_VERSION, dayUnitOf, sourcePredictionId, type SourcePrediction } from '../../shared/evaluation/predictionRecord'
import { expectedMove } from '../../shared/forecast/size'
import { additionCacheKey, askAddition } from './aiAdditionsService'
import { listAiCalls } from './aiLedgerService'
import { writeJsonAtomic } from './atomicWrite'
import { getEffectiveConfig } from './effectiveConfigService'
import { latestForecasts } from './forecastService'
import { getNewsFeedState } from './newsFeedService'
import { recordSourcePrediction } from './predictionLedgerService'

// THE DAILY DIRECTION TEST, ASKED (V10 Stage 7, 19 November 2026; shared/aiAdditions.ts, registered as V10-AI-FORWARD).
// The forward test of AI's way the person approved at $1 a day: once a day, a little after the UTC day opens and while the
// watch is on, the deciding model is asked which way each of ten coins will close a day on -- the forecast's ten most
// traded when it first asks, kept from then on (aiDaily.json) -- shown their last thirty daily closes, the size the
// forecast expects over the day and the latest headlines. It is asked as every addition is (aiAdditionsService.ts): its
// switch, off until switched on under Settings › AI; one call a day; the day's budget; the validator; a ledger row either
// way; and, before that, its own dollar a day. A fresh answer's ten calls are recorded as the source 'ai-daily' at each
// coin's price when it answered, and scored from the venue's bars a day later like every source's. Nothing trades on them.

export const AI_DAILY_SOURCE = 'ai-daily'
const FILE = 'aiDaily.json'
const DAY = 86_400
const TICK_MS = 5 * 60_000
const FIRST_TICK_MS = 3 * 60_000

export const aiDailySeam = {
  dir: (): string => app.getPath('userData'),
  nowSec: (): number => Math.floor(Date.now() / 1000),
  /** The forecast's coins, the most traded first, with their prices now and their day's expected move. */
  forecasts: (): { pair: string; price: number; expectedMove24hPct: number | null }[] =>
    latestForecasts().map((prediction) => {
      const day = prediction.horizons.hours24
      const size = day === undefined ? Number.NaN : expectedMove(day.quantilesPct)
      return { pair: prediction.pair, price: prediction.currentPrice, expectedMove24hPct: Number.isFinite(size) ? Math.round(size * 100) / 100 : null }
    }),
  /** Each coin's daily closes the daily forecast keeps (forecasts/daily-bars.json), oldest first. */
  closes: async (): Promise<Map<string, { time: number; close: number }[]>> => {
    const raw = JSON.parse(await readFile(join(app.getPath('userData'), 'forecasts', 'daily-bars.json'), 'utf-8').catch(() => '{}')) as Record<string, number[][]>
    return new Map(Object.entries(raw).map(([pair, rows]) => [pair, rows.map((row) => ({ time: row[0], close: row[4] }))]))
  },
  headlines: (): { title: string; source: string; publishedAt: number }[] => getNewsFeedState().stories.map((story) => ({ title: story.title, source: story.sourceName, publishedAt: story.publishedAt })),
  /** What the test has spent today, in dollars: its own ledger rows since UTC midnight. */
  spentToday: async (nowSec: number): Promise<number> => {
    const page = await listAiCalls({ promptVersion: AI_ADDITION_PROMPT_VERSIONS.direction, sinceSec: Math.floor(nowSec / DAY) * DAY, limit: 50 })
    return page.rows.reduce((sum, row) => sum + (row.usage.costUsd ?? 0), 0)
  },
  ask: askAddition,
  record: recordSourcePrediction,
  versions: async (): Promise<{ engine: string; config: string }> => {
    const config = await getEffectiveConfig()
    return { engine: config.engineVersion, config: config.configVersion }
  },
  write: (path: string, data: unknown): Promise<void> => writeJsonAtomic(path, data)
}

interface DailyFile {
  /** The coins asked about, fixed when the test first asked. */
  coins: string[]
  startedAt: number
  /** The last UTC day it was asked about. */
  lastDay: number | null
}

let file: DailyFile | null = null
let busy = false
let timer: ReturnType<typeof setInterval> | null = null
let lastNote: string | null = null

async function loadFile(): Promise<DailyFile | null> {
  if (file !== null) return file
  try {
    const raw = JSON.parse(await readFile(join(aiDailySeam.dir(), FILE), 'utf-8')) as Partial<DailyFile>
    if (Array.isArray(raw.coins) && raw.coins.every((coin) => typeof coin === 'string') && typeof raw.startedAt === 'number') file = { coins: raw.coins, startedAt: raw.startedAt, lastDay: typeof raw.lastDay === 'number' ? raw.lastDay : null }
  } catch {
    // Not asked yet.
  }
  return file
}

/** The day's question: each coin's closes up to the day before, its expected move, the latest headlines. */
export function dailyDirectionQuestionOf(
  coins: readonly string[],
  day: number,
  nowSec: number,
  closes: ReadonlyMap<string, readonly { time: number; close: number }[]>,
  forecasts: readonly { pair: string; expectedMove24hPct: number | null }[],
  headlines: readonly { title: string; source: string; publishedAt: number }[]
): DailyDirectionQuestion | null {
  const rows: DailyDirectionQuestion['coins'] = []
  for (const pair of coins) {
    const mine = (closes.get(pair) ?? []).filter((bar) => bar.time < day).sort((a, b) => a.time - b.time).slice(-AI_DAILY_LINES.closes)
    if (mine.length < AI_DAILY_LINES.closes) continue
    rows.push({ pair, closes: mine.map((bar) => bar.close), expectedMove24hPct: forecasts.find((entry) => entry.pair === pair)?.expectedMove24hPct ?? null })
  }
  if (rows.length === 0) return null
  return {
    day: new Date(day * 1000).toISOString().slice(0, 10),
    askedAt: nowSec,
    coins: rows,
    headlines: headlines
      .filter((story) => story.publishedAt <= nowSec)
      .slice(0, AI_DAILY_LINES.headlines)
      .map((story) => ({ title: story.title.slice(0, AI_DAILY_LINES.headlineChars), source: story.source, hoursAgo: Math.max(0, Math.round((nowSec - story.publishedAt) / 3600)) }))
  }
}

/** One turn: once a UTC day, a little after it opens, the question asked and a fresh answer's calls recorded. */
export async function aiDailyTurn(): Promise<void> {
  if (busy) return
  busy = true
  try {
    const nowSec = aiDailySeam.nowSec()
    const day = Math.floor(nowSec / DAY) * DAY
    if (nowSec < day + AI_DAILY_LINES.askAfterSec) return
    const held = await loadFile()
    if (held !== null && held.lastDay === day) return
    // Its own dollar a day, before anything is asked (the person's line); the day's budget is the addition's own check.
    const spent = await aiDailySeam.spentToday(nowSec)
    if (spent >= AI_DAILY_LINES.dailyCapUsd) {
      lastNote = `The daily direction test has spent $${spent.toFixed(4)} today, its dollar a day.`
      return
    }
    const forecasts = aiDailySeam.forecasts()
    const coins = held?.coins ?? forecasts.slice(0, AI_DAILY_LINES.coins).map((entry) => entry.pair)
    if (coins.length === 0) return
    const question = dailyDirectionQuestionOf(coins, day, nowSec, await aiDailySeam.closes(), forecasts, aiDailySeam.headlines())
    if (question === null) {
      lastNote = 'No coin of the test had the thirty daily closes a question needs: the daily forecast keeps them.'
      return
    }
    const outcome = await aiDailySeam.ask({
      kind: 'direction',
      subjectId: question.day,
      symbol: 'BTCUSDT',
      candleTime: day,
      payload: question,
      automatic: true,
      validate: (value) => {
        const checked = validateDailyDirection(value, question)
        return checked.ok ? { ok: true, answer: checked.answer } : checked
      }
    })
    // Skipped (switched off, the watch off, the budget): asked again at a later turn of the day. Anything else settles the day.
    if (outcome.status === 'skipped') {
      lastNote = outcome.reason
      return
    }
    file = { coins: [...coins], startedAt: held?.startedAt ?? nowSec, lastDay: day }
    await aiDailySeam.write(join(aiDailySeam.dir(), FILE), file)
    if (outcome.status !== 'answered' || outcome.cached) {
      lastNote = outcome.status === 'answered' ? 'The day was answered before.' : outcome.reason
      return
    }
    const madeAt = aiDailySeam.nowSec()
    const prices = new Map(aiDailySeam.forecasts().map((entry) => [entry.pair, entry.price]))
    const versions = await aiDailySeam.versions().catch(() => ({ engine: 'unknown', config: 'unknown' }))
    const rowId = additionCacheKey('direction', outcome.model, question)
    let seq = 0
    for (const call of outcome.answer.calls) {
      const price = prices.get(call.pair)
      if (price === undefined || !(price > 0)) continue
      seq++
      const prediction: SourcePrediction = {
        v: SOURCE_RECORD_VERSION,
        id: sourcePredictionId(AI_DAILY_SOURCE, call.pair, madeAt, seq),
        source: AI_DAILY_SOURCE,
        sourceVersion: `${AI_ADDITION_PROMPT_VERSIONS.direction}@${outcome.model}`,
        kind: 'direction',
        pair: call.pair,
        venue: 'binance',
        madeAt,
        bar: null,
        horizonSec: AI_DAILY_LINES.horizonSec,
        refPrice: price,
        side: call.way,
        movePct: null,
        targetPrice: null,
        window: { fromSec: 0, toSec: AI_DAILY_LINES.horizonSec },
        dist: { pRight: call.confidence, q: null, pMove: null },
        scenarios: null,
        cost: { roundTripPct: AI_DAILY_LINES.roundTripPct, basis: 'flat', stakeQuote: 0 },
        expectedNet: null,
        reason: `${outcome.model} called ${call.pair} ${call.way} over a day at ${call.confidence}`,
        evidence: [rowId],
        unit: dayUnitOf(madeAt),
        versions
      }
      try {
        await aiDailySeam.record(prediction)
      } catch (error) {
        console.warn(`The daily direction test could not record ${call.pair}:`, error instanceof Error ? error.message : error)
      }
    }
    lastNote = null
  } catch (error) {
    lastNote = error instanceof Error ? error.message : String(error)
    console.warn('The daily direction test failed a turn:', lastNote)
  } finally {
    busy = false
  }
}

/** Why the last turn asked nothing, where it did not. */
export function aiDailyNote(): string | null {
  return lastNote
}

/** Starts the turns. Called once, from main.ts; asks nothing while the addition is off. */
export function startAiDaily(): void {
  if (timer !== null) return
  setTimeout(() => void aiDailyTurn(), FIRST_TICK_MS)
  timer = setInterval(() => void aiDailyTurn(), TICK_MS)
}

export function stopAiDaily(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

/** Test seam: as a new session finds it. */
export function resetAiDaily(): void {
  file = null
  busy = false
  lastNote = null
  stopAiDaily()
}
