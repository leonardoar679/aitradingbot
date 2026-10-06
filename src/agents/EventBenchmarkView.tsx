import { useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { describeAiBenchmarkCost, describeDuration, formatUsd, type AiConfig } from '../../shared/aiCost'
import {
  EVENT_BENCHMARK_DEFAULT_DAYS,
  EVENT_BENCHMARK_DEFAULT_EVENTS,
  EVENT_BENCHMARK_DEFAULT_PAIRS,
  EVENT_BENCHMARK_EVENT_COUNTS,
  EVENT_BENCHMARK_PAIR_COUNTS,
  EVENT_BENCHMARK_PERIOD_DAYS,
  EVENT_BENCHMARK_STAKE_USD,
  eventBenchmarkWindow,
  eventScoring,
  summarizeEventBenchmark,
  type EventBenchmarkAnswers,
  type EventBenchmarkSummary
} from '../../shared/aiEventBenchmark'
import { splitAiModelId } from '../../shared/aiEffort'
import { experimentDrift, type AiExperimentSummary } from '../../shared/aiExperiment'
import { AI_HELP_NEWS_SECONDS, eventNewsOf } from '../../shared/aiHelp'
import {
  AI_OPPORTUNITY_MAX_MODELS,
  describeOpportunitySide,
  describeQuestionKind,
  opportunitySide,
  questionKindOfPromptVersion,
  type AiOpportunityQuestionKind
} from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import type { Candle } from '../../shared/ipc'
import { EVENT_COOLDOWN_SECONDS, EVENT_DETECTOR_VERSION, EVENT_LOOKBACK_BARS, describeEventType } from '../../shared/marketEvent'
import { scanHistoryRequests } from '../../shared/marketScanner'
import type { StoryMark } from '../../shared/newsFeed'
import { describeError } from '../utils/ipcError'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from './agentStyles'
import { BENCHMARK_CONCURRENCY, runBenchmark } from './benchmark'
import {
  buildEventDataset,
  datasetForQuestion,
  datasetOfExperiment,
  loadOutcomeBars,
  peekEventBenchmark,
  questionOf,
  type EventBenchmarkDeps,
  type EventDataset,
  type EventPeek
} from './eventBenchmark'
import { AiHelpCard } from './AiHelpCard'
import { ContributionTable, CostTable, ExitsTable, ResultsTable, SlicesTable, pct } from './EventTables'
import { LiveBoardCard } from './LiveBoardCard'
import type { CandleFetch } from './opportunities'
import { loadQuantData, quantBacktests, type QuantData, type QuantFetch } from './quantState'

/** Candles are fetched at about this pace, a few at once. Only for saying how long a free step
 * takes before it starts. */
const REQUESTS_PER_SECOND = 8
const REDRAW_MS = 1000
const EVENTS_LISTED = 60

const fetchCandles: CandleFetch = async (exchange, symbol, interval, startSec, endSec) =>
  (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles

const quantFetch: QuantFetch = async (exchange, symbol, interval, startSec, endSec) =>
  (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles

const deps: EventBenchmarkDeps = {
  pickUniverse: (size) => window.api.scanner.pickUniverse(size),
  scanHistory: (request) => window.api.scanner.scanHistory(request),
  fetchCandles,
  peek: (request) => window.api.ai.peekOpportunity(request)
}

type Phase =
  | { status: 'idle' }
  | { status: 'working'; text: string }
  | { status: 'running'; asked: number; toAsk: number; costUsd: number }

function stamp(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

function EventsTable({ dataset, summary, answers }: { dataset: EventDataset; summary: EventBenchmarkSummary; answers: EventBenchmarkAnswers }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const indices = dataset.events.map((_, index) => index)
  const shown = showAll ? indices : indices.slice(-EVENTS_LISTED)
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headCellStyle}>Time (UTC)</th>
              <th style={headCellStyle}>Pair</th>
              <th style={headCellStyle}>Event</th>
              <th style={headCellStyle}>15m move</th>
              {summary.models.map((row) => (
                <th key={row.name} style={headCellStyle}>
                  {describeDecider(row.name)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((index) => {
              const event = dataset.events[index]
              return (
                <tr key={event.id}>
                  <td style={cellStyle}>{stamp(event.time)}</td>
                  <td style={{ ...cellStyle, fontWeight: 600 }}>{event.symbol}</td>
                  <td style={{ ...cellStyle, color: event.direction === 'up' ? 'var(--up)' : 'var(--down)' }}>{describeEventType(event.type)}</td>
                  <td style={cellStyle}>{pct(event.returnsPct.m15)}</td>
                  {summary.models.map((row) => {
                    const decision = answers[row.name]?.[index] ?? null
                    const trade = row.trades.find((entry) => entry.index === index)
                    if (decision === null || decision.error !== null) {
                      return (
                        <td key={row.name} style={{ ...cellStyle, color: 'var(--text-muted)' }}>
                          not asked
                        </td>
                      )
                    }
                    if (decision.rejected) {
                      return (
                        <td key={row.name} style={{ ...cellStyle, color: 'var(--down)' }}>
                          refused
                        </td>
                      )
                    }
                    const side = opportunitySide(decision)
                    return (
                      <td key={row.name} style={cellStyle}>
                        <span style={{ color: side === 'long' ? 'var(--up)' : side === 'short' ? 'var(--down)' : 'var(--text-secondary)', fontWeight: 600 }}>
                          {describeOpportunitySide(side)}
                        </span>{' '}
                        <span style={{ color: 'var(--text-muted)' }}>{Math.round(decision.confidence * 100)}%</span>
                        {trade && trade.outcome.status === 'closed' && <> {pct(trade.outcome.netPct)}</>}
                        {trade && trade.outcome.status === 'expired' && <span style={{ color: 'var(--text-muted)' }}> expired</span>}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {indices.length > EVENTS_LISTED && (
        <button onClick={() => setShowAll((all) => !all)} style={{ ...buttonStyle('secondary'), marginTop: '0.7rem' }}>
          {showAll ? `Show the newest ${EVENTS_LISTED}` : `Show all ${indices.length}`}
        </button>
      )}
    </>
  )
}

function day(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

/** A model under one of the two questions, as one row of the table that sets them side by side. */
function versusKey(model: string, kind: AiOpportunityQuestionKind): string {
  return `${kind}:${model}`
}

function describeVersusKey(name: string): string {
  const cut = name.indexOf(':')
  const kind = name.slice(0, cut)
  if (cut < 0 || (kind !== 'pair' && kind !== 'market')) return name
  return `${describeDecider(name.slice(cut + 1))}, ${describeQuestionKind(kind)}`
}

/** The versions a model's provider said answered in a run, where that is more than its name. */
function servedAs(row: Pick<AiExperimentSummary, 'versions'>, model: string): string {
  const { slug } = splitAiModelId(model)
  const served = (row.versions.served?.[model] ?? []).filter((name) => name !== slug)
  return served.length === 0 ? '' : ` (answered as ${served.join(', ')})`
}

/** Which of the two questions a run asked, from the prompt versions its calls were made under. */
function questionsOf(row: Pick<AiExperimentSummary, 'versions'>): string {
  const kinds = [...new Set(row.versions.prompt.map(questionKindOfPromptVersion).filter((kind): kind is AiOpportunityQuestionKind => kind !== null))]
  return kinds.length === 0 ? '—' : kinds.map(describeQuestionKind).join(', ')
}

/** The runs on record (shared/aiExperiment.ts), newest first. */
function ExperimentsTable({ rows, busy, onOpen }: { rows: AiExperimentSummary[]; busy: boolean; onOpen: (id: string) => void }): React.JSX.Element {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headCellStyle} />
            <th style={headCellStyle}>Experiment</th>
            <th style={headCellStyle}>Run (UTC)</th>
            <th style={headCellStyle}>Events</th>
            <th style={headCellStyle}>Found on</th>
            <th style={headCellStyle}>Models asked</th>
            <th style={headCellStyle}>Question</th>
            <th style={headCellStyle}>Calls</th>
            <th style={headCellStyle}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {/* First, so that it is on screen however wide the rest of the row runs. */}
              <td style={cellStyle}>
                <button onClick={() => onOpen(row.id)} disabled={busy} style={buttonStyle('secondary', busy)}>
                  Open
                </button>
              </td>
              <td style={{ ...cellStyle, fontWeight: 600 }}>{row.id}</td>
              <td style={cellStyle}>{stamp(row.startedAt)}</td>
              <td style={{ ...cellStyle, whiteSpace: 'normal' }}>
                {row.eventCount}
                {row.eventsOf !== null && <span style={{ color: 'var(--text-muted)' }}>, those of {row.eventsOf}</span>}
              </td>
              <td style={{ ...cellStyle, whiteSpace: 'normal' }}>
                {row.pairs.length} pairs, {day(row.startSec)} to {day(row.endSec)}
              </td>
              <td style={{ ...cellStyle, whiteSpace: 'normal' }}>{row.models.map((model) => describeDecider(model) + servedAs(row, model)).join(', ')}</td>
              <td style={{ ...cellStyle, whiteSpace: 'normal' }}>{questionsOf(row)}</td>
              <td style={cellStyle}>
                {row.calls.toLocaleString()}
                {row.failed > 0 && <span style={{ color: 'var(--text-muted)' }}> +{row.failed} unanswered</span>}
              </td>
              <td style={cellStyle}>{formatUsd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The same events, put to several models, and scored by what their recommendations earned
 * (shared/aiEventBenchmark.ts).
 *
 * ONLY "RUN BENCHMARK" CAN SPEND. "Find events" draws a sample: it reads public candles and the
 * answers already held, and shows what they add up to. "Open", on a recorded run, reads that run's
 * own events again instead of drawing new ones. "Run benchmark" states what the missing answers
 * will cost and how long they take, and asks them only after that is agreed to.
 *
 * A RUN THAT ASKED A MODEL IS RECORDED (shared/aiExperiment.ts). "The 20 most traded pairs" is a
 * different twenty tomorrow, so the only way to put a later model beside an earlier one on the
 * same events is to have kept the events.
 *
 * NOTHING HERE TRADES. It asks, scores and shows. */
export function EventBenchmarkView(): React.JSX.Element {
  const [days, setDays] = useState<number>(EVENT_BENCHMARK_DEFAULT_DAYS)
  const [pairCount, setPairCount] = useState<number>(EVENT_BENCHMARK_DEFAULT_PAIRS)
  const [maxEvents, setMaxEvents] = useState<number>(EVENT_BENCHMARK_DEFAULT_EVENTS)
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const [dataset, setDataset] = useState<EventDataset | null>(null)
  const [peek, setPeek] = useState<EventPeek | null>(null)
  const [answers, setAnswers] = useState<EventBenchmarkAnswers>({})
  const [bars, setBars] = useState<Record<string, Candle[]>>({})
  // The two quant strategies at each event and on their own, and the stories on file: "Does AI help?".
  const [quant, setQuant] = useState<{ data: QuantData; window: { startSec: number; endSec: number } } | null>(null)
  const [marks, setMarks] = useState<StoryMark[] | null>(null)
  const quantFor = useRef<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [experiments, setExperiments] = useState<AiExperimentSummary[]>([])
  const [question, setQuestion] = useState<AiOpportunityQuestionKind>('pair')
  /** With the market chosen: the same models' answers to the question about the pair alone, on
   * the same events, for setting the two side by side. */
  const [pairAnswers, setPairAnswers] = useState<EventBenchmarkAnswers | null>(null)
  const stop = useRef(false)
  const scanId = useRef<string | null>(null)

  async function reloadExperiments(): Promise<void> {
    try {
      setExperiments((await window.api.ai.listExperiments()).rows)
    } catch {
      // A list that cannot be read is shown as it last was; the runs themselves are untouched.
    }
  }

  useEffect(() => {
    let cancelled = false
    void window.api.ai.getConfig().then((next) => {
      if (cancelled) return
      setConfig(next)
      setChosen([next.defaultModel])
    })
    void window.api.ai.listExperiments().then(
      (page) => {
        if (!cancelled) setExperiments(page.rows)
      },
      () => undefined
    )
    return (): void => {
      cancelled = true
      // Leaving the tab stops whatever was being asked; what was answered is in the cache.
      stop.current = true
      if (scanId.current !== null) void window.api.scanner.cancelHistory(scanId.current)
    }
  }, [])

  const busy = phase.status !== 'idle'
  const models = peek?.models.map((entry) => entry.model) ?? []
  const summary = useMemo(
    () =>
      dataset === null || models.length === 0
        ? null
        : summarizeEventBenchmark({
            events: dataset.events,
            models,
            answers,
            bars,
            dailyVolume: dataset.dailyVolume,
            labels: dataset.question === 'market' ? dataset.labels : undefined,
            quant: quant?.data.states,
            nowSec: Math.floor(Date.now() / 1000)
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `models` is derived from `peek`
    [dataset, peek, answers, bars, quant]
  )
  const news = useMemo(() => (dataset === null || marks === null ? null : eventNewsOf(dataset.events, marks)), [dataset, marks])
  const backtests = useMemo(() => (quant === null ? null : quantBacktests(quant.data, quant.window, Math.floor(Date.now() / 1000))), [quant])
  // Each model under each question, on the events every one of them answered both ways.
  const versus = useMemo(
    () =>
      dataset === null || pairAnswers === null || question !== 'market' || models.length === 0
        ? null
        : summarizeEventBenchmark({
            events: dataset.events,
            models: models.flatMap((model) => [versusKey(model, 'pair'), versusKey(model, 'market')]),
            answers: Object.fromEntries(models.flatMap((model) => [[versusKey(model, 'pair'), pairAnswers[model] ?? []], [versusKey(model, 'market'), answers[model] ?? []]])),
            bars,
            dailyVolume: dataset.dailyVolume,
            labels: dataset.labels,
            nowSec: Math.floor(Date.now() / 1000)
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `models` is derived from `peek`
    [dataset, peek, answers, pairAnswers, bars, question]
  )

  const window_ = eventBenchmarkWindow(Math.floor(Date.now() / 1000), days)
  // Each event's own question is four requests; with the market, Bitcoin's and ether's are four more.
  const freeRequests = scanHistoryRequests(pairCount, window_.startSec, window_.endSec, EVENT_LOOKBACK_BARS + EVENT_COOLDOWN_SECONDS / 60) + maxEvents * (question === 'market' ? 8 : 4)

  function toggle(model: string): void {
    setChosen((current) => (current.includes(model) ? current.filter((entry) => entry !== model) : [...current, model].slice(0, AI_OPPORTUNITY_MAX_MODELS)))
    // A different set of models is a different comparison: what is on screen no longer describes it.
    setPeek(null)
  }

  async function find(): Promise<void> {
    if (chosen.length === 0) {
      setNote({ ok: false, text: 'Tick at least one model.' })
      return
    }
    stop.current = false
    setNote(null)
    setDataset(null)
    setPeek(null)
    setAnswers({})
    setPairAnswers(null)
    setBars({})
    setQuant(null)
    setMarks(null)
    quantFor.current = null
    const requestId = crypto.randomUUID()
    scanId.current = requestId
    const stopProgress = window.api.scanner.onHistoryProgress((progress) => {
      if (progress.requestId === requestId) setPhase({ status: 'working', text: `Reading history: ${progress.pairsDone} of ${progress.pairsTotal} pairs (${progress.symbol})` })
    })
    try {
      setPhase({ status: 'working', text: 'Choosing the most traded pairs…' })
      const built = await buildEventDataset(
        {
          nowSec: Math.floor(Date.now() / 1000),
          days,
          pairCount,
          maxEvents,
          requestId,
          question,
          shouldStop: () => stop.current,
          onProgress: (progress) => {
            if (progress.step === 'questions') setPhase({ status: 'working', text: `Fetching each event's candles: ${progress.done} of ${progress.total}` })
          }
        },
        deps
      )
      if (stop.current) return
      await load(built, chosen, question)
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      stopProgress()
      scanId.current = null
      setPhase({ status: 'idle' })
    }
  }

  /** What a sample holds for these models under `kind`, and what followed each of its events.
   * Free. With the market, the answers to the question about the pair alone are read as well, to
   * set beside them. `followed` is the candles already fetched for this same sample, when there
   * are any. */
  async function load(built: EventDataset, readFor: string[], kind: AiOpportunityQuestionKind, followed?: Record<string, Candle[]>): Promise<void> {
    setDataset(built)
    setPairAnswers(null)
    if (built.events.length === 0) {
      setNote({ ok: false, text: built.found === 0 ? 'No event was raised on these pairs in this period.' : 'None of the sampled events could be put to a model.' })
      return
    }
    const held = await peekEventBenchmark(built, readFor, deps, {
      question: kind,
      shouldStop: () => stop.current,
      onProgress: (done, total) => setPhase({ status: 'working', text: `Reading what is already answered: ${done} of ${total}` })
    })
    if (stop.current) return
    setPeek(held)
    setAnswers(held.known)
    if (kind === 'market') {
      const alone = await peekEventBenchmark(built, readFor, deps, {
        question: 'pair',
        shouldStop: () => stop.current,
        onProgress: (done, total) => setPhase({ status: 'working', text: `Reading the answers about the pair alone: ${done} of ${total}` })
      })
      if (stop.current) return
      setPairAnswers(alone.known)
    }
    if (followed === undefined) {
      const fetched = await loadOutcomeBars(built.events, Math.floor(Date.now() / 1000), fetchCandles, {
        shouldStop: () => stop.current,
        onProgress: (done, total) => setPhase({ status: 'working', text: `Fetching what followed each event: ${done} of ${total}` })
      })
      if (stop.current) return
      setBars(fetched)
    }
    await loadQuant(built)
  }

  /** The two quant strategies' states at each event of a sample, and the stories on file over its
   * period: public candles, each pair's once, and the news history. Read once a sample. Free. */
  async function loadQuant(built: EventDataset): Promise<void> {
    const key = `${built.startSec}:${built.endSec}:${built.events.map((event) => event.id).join(',')}`
    if (quantFor.current === key) return
    const span = { startSec: built.startSec, endSec: built.endSec }
    const data = await loadQuantData(built.events, span, quantFetch, {
      shouldStop: () => stop.current,
      onProgress: (done, total) => setPhase({ status: 'working', text: `Reading the two strategies at each event: ${done} of ${total} pairs` })
    })
    if (stop.current) return
    let read: StoryMark[] | null = null
    try {
      read = await window.api.feed.history(span.startSec - AI_HELP_NEWS_SECONDS, span.endSec)
    } catch {
      read = null
    }
    quantFor.current = key
    setQuant({ data, window: span })
    setMarks(read)
  }

  /** Reads a recorded run's own events again, and what is held for them. Free. */
  async function open(id: string): Promise<void> {
    stop.current = false
    setNote(null)
    setDataset(null)
    setPeek(null)
    setAnswers({})
    setPairAnswers(null)
    setBars({})
    setQuant(null)
    setMarks(null)
    quantFor.current = null
    try {
      setPhase({ status: 'working', text: `Opening ${id}…` })
      const experiment = await window.api.ai.getExperiment(id)
      if (experiment === null) {
        setNote({ ok: false, text: `${id} is no longer on file.` })
        return
      }
      // Every model that has been asked about this sample, by this run or by another on the same
      // events, as far as it can still be ticked. With none of them enabled, whatever is ticked.
      const sample = experiment.eventsOf ?? experiment.id
      const enabled = config?.enabledModels ?? []
      const asked = experiments
        .filter((row) => (row.eventsOf ?? row.id) === sample)
        .sort((a, b) => a.startedAt - b.startedAt)
        .flatMap((row) => row.models)
      const theirs = [...new Set([...asked, ...experiment.models])].filter((model) => enabled.includes(model)).slice(0, AI_OPPORTUNITY_MAX_MODELS)
      const readFor = theirs.length > 0 ? theirs : chosen
      if (readFor.length === 0) {
        setNote({ ok: false, text: 'Tick at least one model.' })
        return
      }
      setChosen(readFor)
      const built = await datasetOfExperiment(experiment, deps, {
        question,
        shouldStop: () => stop.current,
        onProgress: (progress) => setPhase({ status: 'working', text: `Fetching each event's candles: ${progress.done} of ${progress.total}` })
      })
      if (stop.current) return
      await load(built, readFor, question)
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      setPhase({ status: 'idle' })
    }
  }

  /** The sample on screen, read again for the models now ticked. Free. */
  async function reread(): Promise<void> {
    if (dataset === null) return
    if (chosen.length === 0) {
      setNote({ ok: false, text: 'Tick at least one model.' })
      return
    }
    stop.current = false
    setNote(null)
    try {
      setPhase({ status: 'working', text: 'Reading what is already answered…' })
      await load(dataset, chosen, question, Object.keys(bars).length >= dataset.events.length ? bars : undefined)
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      setPhase({ status: 'idle' })
    }
  }

  /** Puts the same sample as the other question. Free: with the market, Bitcoin's and ether's
   * candles are fetched for each event if they are not held yet, and every answer is read again. */
  async function changeQuestion(kind: AiOpportunityQuestionKind): Promise<void> {
    setQuestion(kind)
    if (dataset === null) return
    if (chosen.length === 0) {
      setPeek(null)
      return
    }
    stop.current = false
    setNote(null)
    try {
      let built = dataset
      if (kind === 'market' && dataset.question !== 'market') {
        built = await datasetForQuestion(dataset, deps, {
          question: 'market',
          shouldStop: () => stop.current,
          onProgress: (progress) => setPhase({ status: 'working', text: `Fetching Bitcoin's and ether's candles for each event: ${progress.done} of ${progress.total}` })
        })
        if (stop.current) return
      }
      // A sample that lost events to the other question has to fetch what followed the rest again.
      const same = built.events.length === dataset.events.length
      await load(built, chosen, kind, same && Object.keys(bars).length >= dataset.events.length ? bars : undefined)
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      setPhase({ status: 'idle' })
    }
  }

  async function run(): Promise<void> {
    if (dataset === null || peek === null) return
    const toAsk = peek.models.reduce((sum, model) => sum + model.toAsk, 0)
    if (toAsk === 0) {
      setNote({ ok: true, text: 'Every answer is already cached. Nothing was asked.' })
      return
    }
    // The pace as it is now, not as it was when the tab was opened: it can be changed under Settings › AI.
    let callsPerMinute: number | undefined
    try {
      callsPerMinute = (await window.api.ai.getConfig()).callsPerMinute
    } catch {
      callsPerMinute = config?.callsPerMinute
    }
    const agreed = window.confirm(
      describeAiBenchmarkCost({
        symbol: `${dataset.pairs} pairs (each event asked ${question === 'market' ? 'with the market around it' : 'about the pair alone'})`,
        decisions: dataset.events.length,
        models: peek.models,
        budgetRemainingUsd: peek.budgetRemainingUsd,
        concurrency: BENCHMARK_CONCURRENCY,
        unit: { one: 'event', many: 'events' },
        callsPerMinute
      })
    )
    if (!agreed) return
    stop.current = false
    setNote(null)
    setPhase({ status: 'running', asked: 0, toAsk, costUsd: 0 })
    let drawn = 0
    const startedAt = Math.floor(Date.now() / 1000)
    const asking = peek.models.filter((entry) => entry.toAsk > 0).map((entry) => entry.model)
    try {
      const result = await runBenchmark({
        times: dataset.events.map((event) => event.time),
        models: peek.models.map((entry) => entry.model),
        known: answers,
        ask: (model, index) => window.api.ai.askOpportunity({ ...questionOf(dataset, index, question), model, source: 'benchmark' }),
        shouldStop: () => stop.current,
        onProgress: (progress, held) => {
          setPhase({ status: 'running', ...progress })
          // The tables are worth redrawing as answers arrive, and not on every one of them.
          if (Date.now() - drawn >= REDRAW_MS) {
            drawn = Date.now()
            setAnswers({ ...held })
          }
        }
      })
      setAnswers(result.answers)
      // What is held now is what a rerun would find: nothing left to ask where it answered.
      setPeek({
        ...peek,
        models: peek.models.map((entry) => {
          const cached = result.answers[entry.model].filter((decision) => decision !== null).length
          return { ...entry, cached, toAsk: dataset.events.length - cached }
        })
      })
      // A run that asked anything is written down with its events, so that it can be opened
      // again when the most traded pairs are no longer these.
      let recorded = ''
      if (result.asked > 0) {
        try {
          const experiment = await window.api.ai.recordExperiment({
            startedAt,
            endedAt: Math.floor(Date.now() / 1000),
            startSec: dataset.startSec,
            endSec: dataset.endSec,
            pairs: dataset.symbols,
            found: dataset.found,
            events: dataset.events,
            models: asking
          })
          recorded = ` Recorded as ${experiment.id}.`
          setDataset({ ...dataset, experimentId: experiment.eventsOf ?? experiment.id })
          void reloadExperiments()
        } catch (failure) {
          recorded = ` The run could not be recorded: ${describeError(failure)}`
        }
      }
      const dropped = result.dropped.map((entry) => `Stopped asking ${describeDecider(entry.model)}: ${entry.error}`).join(' ')
      const made = `This run made ${result.asked.toLocaleString()} model calls and spent ${formatUsd(result.costUsd)}.${recorded}`
      if (result.stopped !== null) {
        setNote({ ok: false, text: `${made} The run stopped early${result.stopped.message ? `: ${result.stopped.message}` : '.'} ${dropped}`.trim() })
      } else {
        setNote({ ok: dropped === '', text: `${made} ${dropped}`.trim() })
      }
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      setPhase({ status: 'idle' })
    }
  }

  function halt(): void {
    stop.current = true
    if (scanId.current !== null) void window.api.scanner.cancelHistory(scanId.current)
  }

  const toAsk = peek?.models.reduce((sum, model) => sum + model.toAsk, 0) ?? 0
  const opened = dataset?.experimentId == null ? null : (experiments.find((row) => row.id === dataset.experimentId) ?? null)
  const drift = opened === null ? [] : experimentDrift(opened, { detector: EVENT_DETECTOR_VERSION, scoring: eventScoring() })
  const everyRow = summary === null ? [] : [...summary.models, ...summary.baselines, ...summary.rules]
  // A side chosen by a coin is the follow row half the time and the fade row the other half.
  const coinToss =
    summary !== null && summary.baselines.length === 2 && summary.baselines.every((row) => row.closed > 0)
      ? (summary.baselines[0].netSumPct + summary.baselines[1].netSumPct) / 2
      : null

  return (
    <>
      <Card title="Events across the market">
        <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Period{' '}
            <select aria-label="Event period" value={days} disabled={busy} onChange={(event) => setDays(Number(event.target.value))} style={inputStyle()}>
              {EVENT_BENCHMARK_PERIOD_DAYS.map((value) => (
                <option key={value} value={value}>
                  {value} days
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Pairs{' '}
            <select aria-label="Pairs scanned" value={pairCount} disabled={busy} onChange={(event) => setPairCount(Number(event.target.value))} style={inputStyle()}>
              {EVENT_BENCHMARK_PAIR_COUNTS.map((value) => (
                <option key={value} value={value}>
                  {value} most traded
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Events{' '}
            <select aria-label="Events sampled" value={maxEvents} disabled={busy} onChange={(event) => setMaxEvents(Number(event.target.value))} style={inputStyle()}>
              {EVENT_BENCHMARK_EVENT_COUNTS.map((value) => (
                <option key={value} value={value}>
                  at most {value}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Question{' '}
            <select
              aria-label="Question"
              value={question}
              disabled={busy}
              onChange={(event) => void changeQuestion(event.target.value === 'market' ? 'market' : 'pair')}
              style={inputStyle()}
            >
              <option value="pair">the pair alone</option>
              <option value="market">with the market around it</option>
            </select>
          </label>
        </div>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.8rem' }}>
          {(config?.enabledModels ?? []).map((model) => (
            <label key={model} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: busy ? 'default' : 'pointer' }}>
              <input type="checkbox" checked={chosen.includes(model)} disabled={busy} onChange={() => toggle(model)} />
              {describeDecider(model)}
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.9rem' }}>
          <button onClick={() => void find()} disabled={busy} style={buttonStyle(peek === null ? 'primary' : 'secondary', busy)}>
            Find events
          </button>
          <button onClick={() => void run()} disabled={busy || peek === null || toAsk === 0} style={buttonStyle('primary', busy || peek === null || toAsk === 0)}>
            {peek !== null && toAsk === 0 ? 'Every answer is held' : 'Run benchmark'}
          </button>
          {busy && (
            <button onClick={halt} style={buttonStyle('secondary')}>
              Stop
            </button>
          )}
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            {phase.status === 'working' && phase.text}
            {phase.status === 'running' && `Asked ${phase.asked.toLocaleString()} of ${phase.toAsk.toLocaleString()} · ${formatUsd(phase.costUsd)} so far`}
          </span>
        </div>
        {note !== null && <p style={{ ...noteStyle, color: note.ok ? 'var(--up)' : 'var(--down)', marginTop: '0.7rem' }}>{note.text}</p>}
        <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
          <strong>Find events</strong> is free: it reads {days} days of 1-minute candles for the {pairCount} most traded pairs, to{' '}
          {stamp(window_.endSec)} UTC, finds the events a running scanner would have raised, takes a sample chosen by a hash of each
          event&apos;s own id, and reads what is already answered. That is about {freeRequests.toLocaleString()} requests of public
          candles, {describeDuration((freeRequests / REQUESTS_PER_SECOND) * 1000)}. <strong>Run benchmark</strong> asks each ticked model
          about each sampled event it has not answered, and states the price and the time first. A day-old cut-off leaves every
          recommendation time to run its course before it is scored. <strong>Question</strong> is what a model is shown: the
          pair&apos;s own event and seven days of its candles, or that and what Bitcoin and ether did over the same fifteen minutes,
          hour, four hours and day, with the pair&apos;s return less theirs. The two are separate questions with separate answers; a
          model asked one has not been asked the other.
        </p>
      </Card>

      {experiments.length > 0 && (
        <Card title="Experiments">
          <ExperimentsTable rows={experiments} busy={busy} onOpen={(id) => void open(id)} />
          <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
            A run that asked a model is kept here with the events it asked about. The most traded pairs are ranked by the last 24
            hours, so <strong>Find events</strong> draws a different sample tomorrow; <strong>Open</strong> reads a run&apos;s own
            events again, and the answers held for them, and is free. To ask another model about the same events, open the run, tick
            the model, read its answers and run the benchmark: only what is missing is asked, and that run is recorded beside this
            one. Results are not stored: they are worked out again from the answers and the candles each time.
          </p>
        </Card>
      )}

      {dataset !== null && (
        <Card title="The sample">
          <p style={{ ...noteStyle, color: 'var(--text-secondary)' }}>
            {dataset.experimentId !== null && `The events of ${dataset.experimentId}. `}
            {dataset.found.toLocaleString()} events on {dataset.pairs} pairs from {stamp(dataset.startSec)} to {stamp(dataset.endSec)} UTC;{' '}
            {dataset.events.length.toLocaleString()} sampled
            {dataset.unaskable > 0 && `, ${dataset.unaskable} more left out because their candles do not make a question`}.
            {summary !== null && ` Compared on ${summary.compared.toLocaleString()} of ${summary.sampled.toLocaleString()}: the events every model has answered.`}
          </p>
          {drift.length > 0 && (
            <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.5rem' }}>
              Not the rules this run was recorded under: {drift.join('; ')}. The answers are what they were; the figures below are
              today&apos;s reading of them.
            </p>
          )}
          {peek === null && !busy && dataset.events.length > 0 && (
            <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.7rem' }}>
              <button onClick={() => void reread()} style={buttonStyle('primary')}>
                Read their answers
              </button>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                The ticked models have changed. Reading what they have answered for these events is free.
              </span>
            </div>
          )}
          {dataset.failedPairs.length > 0 && (
            <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.5rem' }}>
              Could not read: {dataset.failedPairs.map((entry) => `${entry.symbol} (${entry.error})`).join(', ')}
            </p>
          )}
        </Card>
      )}

      {summary !== null && dataset !== null && (
        <>
          <Card title="What each model's recommendations earned">
            <ResultsTable title="Model" rows={summary.models} models />
            <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
              Every figure is over the compared events only. A recommendation is acted on when it takes a side at 65% confidence or
              more; it is then followed to the letter — its entry range, stop, target, validity and holding time — on 1-minute
              candles, from the first minute after the model&apos;s answer would have arrived. &quot;Expired&quot; never filled.
              &quot;Net, added up&quot; is every closed trade&apos;s return after fees and slippage, summed: what equal stakes
              returned, in percent of one. A rate is withheld under 30 closed trades, and ± is a 95% margin on the win rate.
            </p>
          </Card>

          {quant !== null && <AiHelpCard summary={summary} events={dataset.events} news={news} backtests={backtests} failedPairs={quant.data.failed.length} />}

          <Card title="The same events with no model, and with the models combined">
            <ResultsTable title="Rule" rows={[...summary.baselines, summary.buyAndHold, ...summary.quant, ...summary.rules]} models={false} />
            <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
              The first two rows take every {summary.baselinesOver === 'compared' ? 'compared' : 'sampled'} event with one fixed
              bracket and no judgement: with the move, and against it
              {summary.baselinesOver === 'sampled' && ' (no model has answered yet, so there is nothing to compare them on: this is what the events did on their own)'}
              . research/EVENTS.md scored both over years and found each loses about a round trip&apos;s cost; a model is worth its
              price by as much as it beats them here. Buying and holding each event&apos;s pair an hour from the same entry is what the
              market did in those hours, and the two quant rows follow the move only where the strategy, read at the event from its own
              rule, is on its side. The rest are worked out from the answers above and cost nothing: what would
              have been traded had a side needed more than half the models, all of them, or the weight of their confidence, using
              the levels of the model surest of that side and waiting for the slowest answer.
              {coinToss !== null && (
                <>
                  {' '}
                  Tossing a coin for the side is expected to return the average of the first two rows: {pct(coinToss)} added up.
                </>
              )}
            </p>
          </Card>

          {versus !== null && (
            <Card title="The pair alone, and with the market">
              {versus.compared === 0 ? (
                <p style={noteStyle}>
                  No event has been answered both ways by every ticked model yet, so there is nothing to set side by side. Run the
                  benchmark under each question on this sample: what is held for one is not asked again.
                </p>
              ) : (
                <ResultsTable
                  title="Model, question"
                  rows={[...versus.models, ...versus.baselines]}
                  models
                  label={(name) => describeVersusKey(name)}
                />
              )}
              <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
                Each ticked model twice: answering the question about the pair alone, and the same event with the market around it,
                over the {versus.compared.toLocaleString()} events every one of them answered both ways — so the two rows of a model
                differ only in what it was shown. The last two rows are the same events with no model. A difference here is worth
                trusting only when it holds in the three parts of the period below and is larger than the margin on the win rate.
              </p>
            </Card>
          )}

          {summary.contributions.length > 0 && (
            <Card title="What each model changed">
              <ContributionTable contributions={summary.contributions} models={summary.models} />
              <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
                A model&apos;s own row runs two things together: which events it chose, and the levels it traded them with. This sets
                both against the one thing that is the same for every event, the fixed bracket of &quot;follow every event&quot;. The
                third column is the model&apos;s own trades; the fourth is the fixed bracket on those same calls, on the side the model
                took — what the rule would have traded had it waited for the model to confirm it; the fifth is the rule on the
                events the model let go. Each is net added up, with its closed trades in brackets. The last three columns are in net a
                trade and add up: how far the model came out from following everything, how much of that was its choice of events,
                and how much its levels. An entry of the model&apos;s that never filled is in none of its own figures, while the fixed
                bracket always enters.
              </p>
            </Card>
          )}

          <Card title="How the trades ended">
            <ExitsTable rows={everyRow} />
          </Card>

          <Card title="Speed, cost, and the period in three parts">
            <CostTable rows={summary.models} />
            <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
              The dollar columns put every trade at {formatUsd(EVENT_BENCHMARK_STAKE_USD)}, only so that a model&apos;s results can be
              set against what its answers cost. The last three columns are the period cut into three consecutive parts, with the
              number of closed trades in each: a result that holds in one part and not the others is one stretch of market, not a
              model.
            </p>
          </Card>

          <Card title="Where a row's result came from">
            <SlicesTable rows={everyRow} />
          </Card>

          <Card title="Every event">
            <EventsTable dataset={dataset} summary={summary} answers={answers} />
          </Card>

          <LiveBoardCard title="The same models on events the watch asked about live" models={models} />
        </>
      )}
    </>
  )
}
