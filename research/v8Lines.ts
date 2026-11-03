// V8'S OPEN LINES, READ ON A PROFILE'S RECORDS (V8 Stage 12, 3 November 2026): the figures the registrations judged on
// the Stage 12 runs' and the user's own records ask for, each read as its line says --
//   V8-S0-ROUTING     every model call since SINCE: no answer accepted from another provider's model, every call
//                     carrying its role, and every call asking the model its role names (the profile's aiConfig.json);
//   V8-S2-RECORD      every source prediction due by END with exactly one outcome, the missing ones' share, and each
//                     outcome scored again (shared/evaluation/predictionRecord.ts sourceOutcomeOf) from the venue's
//                     one-minute bars read again from Binance's public API, to six decimals (RESCORE=1);
//   V8-S2-LIQ         the liquidity gate's refusals among the paper books' misses, by writer (exploratory);
//   V8-S3-EV          the cards shown (predictions/cards-*.jsonl) and their units, against the ten and five it needs;
//   V8-S3-MOVES       the large moves on file and who called them (exploratory);
//   V8-S6-SKILL, V8-S6-DELAY, V8-S7-CLONE  each trader's last analysis on file;
//   V8-S9-BOOKS       the books' trades by book and how they ended (the books' report itself is the app's).
// It reads only the profile's own files, and Binance's public klines with RESCORE=1.
//
//   npx esbuild research/v8Lines.ts --bundle --platform=node --format=esm --outfile=research/.v8Lines.mjs
//   PROFILE=<profile> SINCE=<unix seconds> [END=<unix seconds>] [RESCORE=1] [OUT=<figures.json>] node research/.v8Lines.mjs
// END is the record's end: a run's last moment, so that a line due after the app closed is not asked for.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SOURCE_RECORD_LINES, dueAt, readSourceOutcome, readSourcePrediction, sourceOutcomeOf, type SourceOutcome, type SourcePrediction } from '../shared/evaluation/predictionRecord'
import type { Candle } from '../shared/ipc'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '' || !existsSync(PROFILE)) throw new Error('PROFILE is the profile folder to read')
const SINCE = Number(process.env.SINCE ?? 0)
const END = Number(process.env.END ?? Math.floor(Date.now() / 1000))
const RESCORE = process.env.RESCORE === '1'
const OUT = process.env.OUT ?? ''

const lines = (dir: string, pattern: RegExp): unknown[] => {
  if (!existsSync(dir)) return []
  const out: unknown[] = []
  for (const name of readdirSync(dir).filter((entry) => pattern.test(entry)).sort())
    for (const line of readFileSync(join(dir, name), 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // A torn line: skipped.
      }
    }
  return out
}
const json = (path: string): Record<string, unknown> | null => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>) : null)
const count = <T>(items: readonly T[], key: (item: T) => string): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1
  return out
}
const result: Record<string, unknown> = { profile: PROFILE, since: SINCE, end: END }

// V8-S0-ROUTING.
{
  type Row = { at: number; source?: string; addition?: string | null; role?: string | null; model?: string; servedModel?: string | null; servedMismatch?: string | null; status?: string }
  const rows = (lines(join(PROFILE, 'aiLedger'), /^calls-.*\.jsonl$/) as Row[]).filter((row) => row.at >= SINCE && row.at <= END)
  const config = json(join(PROFILE, 'aiConfig.json')) ?? {}
  const roles = (config.roles ?? {}) as { gate?: string | null; summarize?: string | null }
  const modelOf: Record<string, string | null | undefined> = { decide: config.defaultModel as string | undefined, gate: roles.gate, summarize: roles.summarize }
  const acceptedOther = rows.filter((row) => row.status === 'ok' && row.servedMismatch === 'other')
  const withoutRole = rows.filter((row) => typeof row.role !== 'string' || row.role === '')
  const otherModel = rows.filter((row) => typeof row.role === 'string' && modelOf[row.role] !== undefined && modelOf[row.role] !== null && row.model !== modelOf[row.role])
  result.routing = {
    calls: rows.length,
    byCaller: count(rows, (row) => `${row.source}${row.addition ? `/${row.addition}` : ''} ${row.role ?? '-'} ${row.model} -> ${row.servedModel ?? '-'} ${row.status}`),
    roles: modelOf,
    acceptedFromAnotherProvider: acceptedOther.length,
    withoutRole: withoutRole.length,
    askedAnotherModel: otherModel.length,
    costUsd: rows.reduce((sum, row) => sum + (((row as { usage?: { costUsd?: number } }).usage?.costUsd as number | undefined) ?? 0), 0),
    held: rows.length === 0 ? null : acceptedOther.length === 0 && withoutRole.length === 0 && otherModel.length === 0
  }
}

// V8-S2-RECORD.
async function binanceMinutes(pair: string, fromSec: number, toSec: number): Promise<Candle[]> {
  const out: Candle[] = []
  let start = fromSec
  for (let page = 0; page < 10 && start < toSec; page++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&startTime=${start * 1000}&endTime=${toSec * 1000 - 1}&limit=1000`
    let answer: unknown[][] | null = null
    for (let attempt = 0; attempt < 3 && answer === null; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (response.ok) answer = (await response.json()) as unknown[][]
        else await new Promise((resolve) => setTimeout(resolve, 2000))
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
    if (answer === null || answer.length === 0) break
    for (const row of answer) out.push({ time: Number(row[0]) / 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) } as Candle)
    start = Number(answer[answer.length - 1][0]) / 1000 + 60
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return out
}
{
  const predictions = lines(join(PROFILE, 'predictions'), /^sources-.*\.jsonl$/)
    .map(readSourcePrediction)
    .filter((entry): entry is SourcePrediction => entry !== null)
  const outcomes = lines(join(PROFILE, 'predictions'), /^source-outcomes-.*\.jsonl$/)
    .map(readSourceOutcome)
    .filter((entry): entry is SourceOutcome => entry !== null)
  const byId = new Map<string, SourceOutcome[]>()
  for (const outcome of outcomes) byId.set(outcome.id, [...(byId.get(outcome.id) ?? []), outcome])
  const due = predictions.filter((entry) => entry.madeAt >= SINCE && dueAt(entry) + SOURCE_RECORD_LINES.graceSec <= END)
  const without = due.filter((entry) => !byId.has(entry.id))
  const twice = due.filter((entry) => (byId.get(entry.id)?.length ?? 0) > 1)
  const missing = due.filter((entry) => byId.get(entry.id)?.[0]?.status === 'missing')
  const rescored = { read: 0, equal: 0, differ: [] as { id: string; field: string; file: unknown; again: unknown }[], notRead: 0 }
  if (RESCORE) {
    for (const prediction of due) {
      const outcome = byId.get(prediction.id)?.[0]
      if (outcome === undefined || outcome.status === 'missing' || prediction.venue !== 'binance') continue
      const firstMinute = Math.ceil(prediction.madeAt / 60) * 60
      const bars = await binanceMinutes(prediction.pair, firstMinute, dueAt(prediction))
      if (bars.length === 0) {
        rescored.notRead++
        continue
      }
      const again = sourceOutcomeOf(prediction, bars, outcome.at)
      rescored.read++
      let same = true
      for (const field of ['status', 'closePrice', 'movePct', 'bestPct', 'worstPct', 'right', 'sizeErrorPct', 'touched', 'touchSec', 'netPct'] as const) {
        const a = outcome[field]
        const b = again[field]
        const equal = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 5e-7 : a === b
        if (!equal) {
          same = false
          if (rescored.differ.length < 20) rescored.differ.push({ id: prediction.id, field, file: a, again: b })
        }
      }
      if (same) rescored.equal++
    }
  }
  result.record = {
    predictions: predictions.length,
    bySource: count(predictions, (entry) => `${entry.source}/${entry.kind}`),
    due: due.length,
    withoutOutcome: without.length,
    withTwo: twice.length,
    missing: missing.length,
    missingWhy: count(missing, (entry) => byId.get(entry.id)?.[0]?.why ?? '-'),
    rescored: RESCORE ? rescored : 'not asked',
    held: due.length === 0 ? null : without.length === 0 && twice.length === 0 && missing.length <= 0.01 * due.length && (!RESCORE || (rescored.differ.length === 0 && rescored.notRead === 0))
  }
}

// V8-S2-LIQ, V8-S3-EV, V8-S3-MOVES.
{
  type Miss = { at: number; book?: string; writer?: string; stage?: string; reason?: string; shadow?: boolean }
  const misses = (lines(join(PROFILE, 'paperBooks'), /^misses-.*\.jsonl$/) as Miss[]).filter((miss) => miss.at >= SINCE && miss.at <= END)
  result.misses = { all: misses.length, byStage: count(misses, (miss) => `${miss.book ?? '-'}/${miss.writer ?? '-'}/${miss.stage ?? '-'}${miss.shadow ? '/shadow' : ''}`), liquidity: misses.filter((miss) => miss.stage === 'liquidity').map((miss) => ({ at: miss.at, writer: miss.writer, shadow: miss.shadow ?? false, reason: (miss.reason ?? '').slice(0, 160) })).slice(0, 30) }
  type Card = { at: number; pair: string; state: string; source: string | null; predictionId: string | null; why?: string }
  const cards = (lines(join(PROFILE, 'predictions'), /^cards-.*\.jsonl$/) as Card[]).filter((card) => card.at >= SINCE && card.at <= END)
  const shown = cards.filter((card) => card.state !== 'none')
  result.cards = { states: cards.length, byState: count(cards, (card) => card.state), byWhy: count(cards, (card) => card.why ?? '-'), shown: shown.length, units: new Set(shown.map((card) => `${card.source}:${Math.floor(card.at / 3600)}`)).size }
  type Move = { at: number; pair: string; span: string; movePct: number; calledBy: unknown[] }
  const moves = (lines(join(PROFILE, 'predictions'), /^moves-.*\.jsonl$/) as Move[]).filter((move) => move.at >= SINCE && move.at <= END)
  result.moves = { all: moves.length, bySpan: count(moves, (move) => move.span), called: moves.filter((move) => Array.isArray(move.calledBy) && move.calledBy.length > 0).length, calledBy: count(moves.flatMap((move) => (Array.isArray(move.calledBy) ? move.calledBy : []).map((entry) => JSON.stringify(entry).slice(0, 60))), (entry) => entry), largest: [...moves].sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct)).slice(0, 5).map((move) => `${move.pair} ${move.span} ${move.movePct.toFixed(2)}%`) }
}

// V8-S6-SKILL, V8-S6-DELAY, V8-S7-CLONE: each trader's last analysis.
{
  const tradersDir = join(PROFILE, 'traders')
  const traders: Record<string, unknown>[] = []
  for (const key of existsSync(tradersDir) ? readdirSync(tradersDir).sort() : []) {
    const analyses = lines(join(tradersDir, key), /^analyses-.*\.jsonl$/) as Record<string, unknown>[]
    const last = analyses[analyses.length - 1] as Record<string, any> | undefined
    if (last === undefined) continue
    traders.push({
      key,
      at: last.at,
      source: last.record?.source,
      label: last.record?.label,
      records: last.record?.records,
      skill: last.skill === null ? null : { verdict: last.skill?.verdict, trips: last.skill?.trips ?? last.skill?.n, reasons: last.skill?.reasons },
      delay: last.delay === null ? null : { followable: last.delay?.followable ?? null, rows: (last.delay?.rows ?? []).slice(0, 6) },
      clone: last.clone === null ? null : { verdict: last.clone?.verdict, auc: last.clone?.outOfTime?.auc, interval: last.clone?.outOfTime?.interval, reasons: last.clone?.reasons }
    })
  }
  result.traders = traders
}

// V8-S9-BOOKS: the books' trades and how they ended.
{
  type Executor = { id: string; mode?: string; status?: string; createdAt?: number; symbol?: string; book?: { id?: string; ledger?: string; startedAt?: number; result?: { netQuote?: number; netPct?: number; closedAt?: number } } }
  const settings = json(join(PROFILE, 'settings.json')) ?? {}
  const all = [...(((settings.executors as Executor[] | undefined) ?? []) as Executor[]), ...(lines(join(PROFILE, 'paperBooks'), /^archive-.*\.jsonl$/) as Executor[])]
  const seen = new Set<string>()
  const books = all.filter((executor) => executor.book?.id !== undefined && (executor.createdAt ?? 0) >= SINCE && !seen.has(executor.id) && seen.add(executor.id))
  const byBook: Record<string, { trades: number; closed: number; open: number; netQuote: number; ledgers: Record<string, number> }> = {}
  for (const executor of books) {
    const mine = (byBook[executor.book!.id!] ??= { trades: 0, closed: 0, open: 0, netQuote: 0, ledgers: {} })
    mine.trades++
    if (executor.book?.result?.closedAt !== undefined) {
      mine.closed++
      mine.netQuote += executor.book.result.netQuote ?? 0
    } else mine.open++
    mine.ledgers[executor.book?.ledger ?? '-'] = (mine.ledgers[executor.book?.ledger ?? '-'] ?? 0) + 1
  }
  result.books = { byBook, notPaper: books.filter((executor) => executor.mode !== 'paper').length, runs: lines(join(PROFILE, 'paperBooks'), /^runs-.*\.jsonl$/) }
}

if (OUT !== '') writeFileSync(OUT, JSON.stringify(result, null, 1))
console.log(JSON.stringify(result, null, 1).slice(0, 6000))
