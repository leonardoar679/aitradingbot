import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { ForecastBar } from '../../shared/forecast/bars'
import type { Candle } from '../../shared/ipc'
import { movesOf, readMoveLine, type MoveLine } from '../../shared/evaluation/moves'
import { CARD_STATE_VERSION, type CardStateLine } from '../../shared/forecast/primaryCall'
import {
  SOURCE_RECORD_LINES,
  dueAt,
  readSourceOutcome,
  readSourcePrediction,
  sourceOutcomeOf,
  SOURCE_RECORD_VERSION,
  type SourceOutcome,
  type SourcePrediction
} from '../../shared/evaluation/predictionRecord'
import { appendJsonLine, appendJsonLines, listMonthFiles } from './jsonlStore'
import { fetchHistoricalRange } from './marketService'

// THE RECORD OF EVERY PREDICTION THAT IS NOT THE FORECAST'S OWN, KEPT AND SETTLED (shared/evaluation/
// predictionRecord.ts; V8 Stage 2). A prediction is written to predictions/sources-YYYY-MM.jsonl when it is
// made; once its horizon has passed it is settled from its venue's one-minute bars into
// predictions/source-outcomes-YYYY-MM.jsonl, one outcome a prediction. At a start the owed ones of the last
// eight days are read back and settled, late; one older than that, or whose bars could not be read for six
// hours past its due time, is written MISSING with its reason, so that no line goes unanswered. The files are
// never swept. Public market data only: no key, no model, no order.

/** After its due time, how long an outcome's bars are asked for before it is written missing. */
const MISSING_AFTER_SEC = 6 * 3600
const TICK_MS = 60_000

/** What the service reads the world through: a test hands in its own. */
export const predictionLedgerSeam = {
  dir: (): string => join(app.getPath('userData'), 'predictions'),
  now: (): number => Math.floor(Date.now() / 1000),
  bars: async (venue: SourcePrediction['venue'], pair: string, fromSec: number, toSec: number): Promise<Candle[]> => {
    const { candles } = await fetchHistoricalRange(venue, pair, '1m', fromSec, toSec, `prediction:${pair}:${fromSec}`, () => undefined)
    return candles
  }
}

const monthOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 7)
const predictionsFile = (seconds: number): string => join(predictionLedgerSeam.dir(), `sources-${monthOf(seconds)}.jsonl`)
const outcomesFile = (seconds: number): string => join(predictionLedgerSeam.dir(), `source-outcomes-${monthOf(seconds)}.jsonl`)

const owed = new Map<string, SourcePrediction>()
/** Ids with an outcome on file, so none is settled twice. */
const settled = new Set<string>()
const listeners = new Set<(prediction: SourcePrediction, outcome: SourceOutcome) => void>()
let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

/** Tells a listener each outcome as it is settled. */
export function onSourceOutcome(listener: (prediction: SourcePrediction, outcome: SourceOutcome) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Writes a prediction as it is made, and owes its outcome. Refuses one this version cannot read back. */
export async function recordSourcePrediction(prediction: SourcePrediction): Promise<void> {
  if (readSourcePrediction(prediction) === null) throw new Error(`A ${String(prediction?.source)} prediction cannot be recorded: it is not a whole ${SOURCE_RECORD_VERSION} line`)
  if (owed.has(prediction.id) || settled.has(prediction.id)) throw new Error(`The prediction ${prediction.id} is on file already`)
  await appendJsonLine(predictionsFile(prediction.madeAt), prediction)
  owed.set(prediction.id, prediction)
}

async function writeOutcome(prediction: SourcePrediction, outcome: SourceOutcome): Promise<void> {
  await appendJsonLine(outcomesFile(prediction.madeAt), outcome)
  owed.delete(prediction.id)
  settled.add(prediction.id)
  for (const listener of listeners) {
    try {
      listener(prediction, outcome)
    } catch (error) {
      console.error('A prediction-outcome listener failed:', error)
    }
  }
}

const missingOf = (prediction: SourcePrediction, at: number, why: string): SourceOutcome => ({
  v: SOURCE_RECORD_VERSION,
  id: prediction.id,
  at,
  status: 'missing',
  closePrice: null,
  movePct: null,
  bestPct: null,
  worstPct: null,
  right: null,
  sizeErrorPct: null,
  touched: null,
  touchSec: null,
  netPct: null,
  why
})

/** Settles every owed prediction whose horizon has passed: one pass, one at a time. */
export async function settleOwed(): Promise<number> {
  if (ticking) return 0
  ticking = true
  let done = 0
  try {
    const now = predictionLedgerSeam.now()
    const due = [...owed.values()].filter((prediction) => dueAt(prediction) + 60 <= now).sort((a, b) => dueAt(a) - dueAt(b))
    for (const prediction of due) {
      try {
        const bars = await predictionLedgerSeam.bars(prediction.venue, prediction.pair, prediction.madeAt, dueAt(prediction))
        const outcome = sourceOutcomeOf(prediction, bars, predictionLedgerSeam.now())
        if (outcome.status === 'missing' && now < dueAt(prediction) + MISSING_AFTER_SEC) continue
        await writeOutcome(prediction, outcome)
        done++
      } catch (error) {
        if (now >= dueAt(prediction) + MISSING_AFTER_SEC) {
          await writeOutcome(prediction, missingOf(prediction, now, `its bars could not be read for six hours: ${error instanceof Error ? error.message : String(error)}`))
          done++
        }
      }
    }
  } finally {
    ticking = false
  }
  return done
}

async function linesOf(path: string): Promise<unknown[]> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return []
  }
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn last line is skipped, as every record here skips one.
    }
  }
  return out
}

/** Every prediction on file with its outcome, or none yet; for a page and a report. */
export async function sourceRecord(filter: { source?: string; sinceSec?: number } = {}): Promise<{ prediction: SourcePrediction; outcome: SourceOutcome | null }[]> {
  const dir = predictionLedgerSeam.dir()
  const months = await listMonthFiles(dir, /^sources-(\d{4}-\d{2})\.jsonl$/)
  const predictions: SourcePrediction[] = []
  const outcomes = new Map<string, SourceOutcome>()
  for (const { name, month } of months) {
    for (const raw of await linesOf(join(dir, name))) {
      const prediction = readSourcePrediction(raw)
      if (prediction === null) continue
      if (filter.source !== undefined && prediction.source !== filter.source) continue
      if (filter.sinceSec !== undefined && prediction.madeAt < filter.sinceSec) continue
      predictions.push(prediction)
    }
    for (const raw of await linesOf(join(dir, `source-outcomes-${month}.jsonl`))) {
      const outcome = readSourceOutcome(raw)
      if (outcome !== null && !outcomes.has(outcome.id)) outcomes.set(outcome.id, outcome)
    }
  }
  return predictions.sort((a, b) => a.madeAt - b.madeAt).map((prediction) => ({ prediction, outcome: outcomes.get(prediction.id) ?? null }))
}

/** MOVES NOBODY CALLED (shared/evaluation/moves.ts): at a whole hour, the large moves of the pairs whose bars are held
 * over the hour and the day that ended, each with the predictions on file that called it, appended to
 * predictions/moves-YYYY-MM.jsonl. An hour is written once: a pass made again at the same close (the models coming
 * ready) and a start within the hour find it on file; the passes run one at a time. */
const movesFile = (seconds: number): string => join(predictionLedgerSeam.dir(), `moves-${monthOf(seconds)}.jsonl`)

export async function recordHourMoves(atSec: number, pairs: readonly string[], barsOf: (pair: string) => readonly ForecastBar[] | null): Promise<number> {
  if (atSec % 3600 !== 0) return 0
  for (const raw of await linesOf(movesFile(atSec))) {
    const line = readMoveLine(raw)
    if (line !== null && line.at === atSec) return 0
  }
  const predictions = (await sourceRecord({ sinceSec: atSec - SOURCE_RECORD_LINES.owedLookbackSec })).map((entry) => entry.prediction)
  const lines: MoveLine[] = []
  for (const pair of pairs) {
    const bars = barsOf(pair)
    if (bars === null || bars.length === 0) continue
    lines.push(...movesOf(pair, 'binance', bars, atSec, predictions))
  }
  if (lines.length > 0) await appendJsonLines(movesFile(atSec), lines)
  return lines.length
}

/** EACH COIN'S CARD STATE AT A WHOLE HOUR (shared/forecast/primaryCall.ts cardStatesOf), appended to
 * predictions/cards-YYYY-MM.jsonl: an hour written once, as the moves are. */
const cardsFile = (seconds: number): string => join(predictionLedgerSeam.dir(), `cards-${monthOf(seconds)}.jsonl`)

export async function recordCardStates(atSec: number, lines: readonly CardStateLine[]): Promise<number> {
  if (atSec % 3600 !== 0) return 0
  for (const raw of await linesOf(cardsFile(atSec))) {
    if (typeof raw === 'object' && raw !== null && (raw as { v?: unknown; at?: unknown }).v === CARD_STATE_VERSION && (raw as { at?: unknown }).at === atSec) return 0
  }
  if (lines.length > 0) await appendJsonLines(cardsFile(atSec), lines)
  return lines.length
}

/** The large moves on file since a moment, oldest first; for the Performance page and a run's report. */
export async function moveRecord(sinceSec = 0): Promise<MoveLine[]> {
  const dir = predictionLedgerSeam.dir()
  const out: MoveLine[] = []
  for (const { name } of await listMonthFiles(dir, /^moves-(\d{4}-\d{2})\.jsonl$/)) {
    for (const raw of await linesOf(join(dir, name))) {
      const line = readMoveLine(raw)
      if (line !== null && line.at >= sinceSec) out.push(line)
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Reads back what is owed, writes missing what is past the look-back, and settles every minute. */
export async function startPredictionLedger(): Promise<void> {
  const now = predictionLedgerSeam.now()
  for (const { prediction, outcome } of await sourceRecord()) {
    if (outcome !== null) {
      settled.add(prediction.id)
      continue
    }
    if (prediction.madeAt < now - SOURCE_RECORD_LINES.owedLookbackSec) {
      await writeOutcome(prediction, missingOf(prediction, now, 'the app was not running to settle it within eight days of its making'))
    } else {
      owed.set(prediction.id, prediction)
    }
  }
  if (timer === null) {
    timer = setInterval(() => void settleOwed().catch((error) => console.error('Settling the predictions failed:', error)), TICK_MS)
    void settleOwed().catch((error) => console.error('Settling the predictions failed:', error))
  }
}

/** Test seam: as a new session finds it. */
export function resetPredictionLedger(): void {
  owed.clear()
  settled.clear()
  listeners.clear()
  if (timer !== null) clearInterval(timer)
  timer = null
  ticking = false
}

/** How many predictions are owed their outcome now. */
export function owedCount(): number {
  return owed.size
}
