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
  summarizeEventBenchmark,
  type EventBenchmarkAnswers,
  type EventBenchmarkSummary
} from '../../shared/aiEventBenchmark'
import { AI_OPPORTUNITY_MAX_MODELS, describeOpportunitySide, opportunitySide } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import type { Candle } from '../../shared/ipc'
import { EVENT_COOLDOWN_SECONDS, EVENT_LOOKBACK_BARS, describeEventType } from '../../shared/marketEvent'
import { scanHistoryRequests } from '../../shared/marketScanner'
import { describeError } from '../utils/ipcError'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from './agentStyles'
import { BENCHMARK_CONCURRENCY, runBenchmark } from './benchmark'
import { buildEventDataset, loadOutcomeBars, peekEventBenchmark, type EventBenchmarkDeps, type EventDataset, type EventPeek } from './eventBenchmark'
import { CostTable, ResultsTable, SlicesTable, pct } from './EventTables'
import { LiveBoardCard } from './LiveBoardCard'
import type { CandleFetch } from './opportunities'

/** Candles are fetched at about this pace, a few at once. Only for saying how long a free step
 * takes before it starts. */
const REQUESTS_PER_SECOND = 8
const REDRAW_MS = 1000
const EVENTS_LISTED = 60

const fetchCandles: CandleFetch = async (exchange, symbol, interval, startSec, endSec) =>
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

/** The same events, put to several models, and scored by what their recommendations earned
 * (shared/aiEventBenchmark.ts).
 *
 * TWO BUTTONS, AND ONLY THE SECOND CAN SPEND. "Find events" reads public candles and the answers
 * already held, and shows what they add up to. "Run benchmark" states what the missing answers
 * will cost and how long they take, and asks them only after that is agreed to.
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
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const stop = useRef(false)
  const scanId = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.ai.getConfig().then((next) => {
      if (cancelled) return
      setConfig(next)
      setChosen([next.defaultModel])
    })
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
        : summarizeEventBenchmark({ events: dataset.events, models, answers, bars, dailyVolume: dataset.dailyVolume, nowSec: Math.floor(Date.now() / 1000) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `models` is derived from `peek`
    [dataset, peek, answers, bars]
  )

  const window_ = eventBenchmarkWindow(Math.floor(Date.now() / 1000), days)
  const freeRequests = scanHistoryRequests(pairCount, window_.startSec, window_.endSec, EVENT_LOOKBACK_BARS + EVENT_COOLDOWN_SECONDS / 60) + maxEvents * 4

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
    setBars({})
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
          shouldStop: () => stop.current,
          onProgress: (progress) => {
            if (progress.step === 'questions') setPhase({ status: 'working', text: `Fetching each event's candles: ${progress.done} of ${progress.total}` })
          }
        },
        deps
      )
      if (stop.current) return
      setDataset(built)
      if (built.events.length === 0) {
        setNote({ ok: false, text: built.found === 0 ? 'No event was raised on these pairs in this period.' : 'None of the sampled events could be put to a model.' })
        return
      }
      const held = await peekEventBenchmark(built, chosen, deps, {
        shouldStop: () => stop.current,
        onProgress: (done, total) => setPhase({ status: 'working', text: `Reading what is already answered: ${done} of ${total}` })
      })
      if (stop.current) return
      setPeek(held)
      setAnswers(held.known)
      const fetched = await loadOutcomeBars(built.events, Math.floor(Date.now() / 1000), fetchCandles, {
        shouldStop: () => stop.current,
        onProgress: (done, total) => setPhase({ status: 'working', text: `Fetching what followed each event: ${done} of ${total}` })
      })
      if (!stop.current) setBars(fetched)
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      stopProgress()
      scanId.current = null
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
    const agreed = window.confirm(
      describeAiBenchmarkCost({
        symbol: `${dataset.pairs} pairs`,
        decisions: dataset.events.length,
        models: peek.models,
        budgetRemainingUsd: peek.budgetRemainingUsd,
        concurrency: BENCHMARK_CONCURRENCY,
        unit: { one: 'event', many: 'events' }
      })
    )
    if (!agreed) return
    stop.current = false
    setNote(null)
    setPhase({ status: 'running', asked: 0, toAsk, costUsd: 0 })
    let drawn = 0
    try {
      const result = await runBenchmark({
        times: dataset.events.map((event) => event.time),
        models: peek.models.map((entry) => entry.model),
        known: answers,
        ask: (model, index) =>
          window.api.ai.askOpportunity({ exchange: dataset.events[index].exchange, symbol: dataset.events[index].symbol, ...dataset.questions[index], model, source: 'benchmark' }),
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
      const dropped = result.dropped.map((entry) => `Stopped asking ${describeDecider(entry.model)}: ${entry.error}`).join(' ')
      const made = `This run made ${result.asked.toLocaleString()} model calls and spent ${formatUsd(result.costUsd)}.`
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
  const everyRow = summary === null ? [] : [...summary.models, ...summary.baselines, ...summary.rules]

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
          recommendation time to run its course before it is scored.
        </p>
      </Card>

      {dataset !== null && (
        <Card title="The sample">
          <p style={{ ...noteStyle, color: 'var(--text-secondary)' }}>
            {dataset.found.toLocaleString()} events on {dataset.pairs} pairs from {stamp(dataset.startSec)} to {stamp(dataset.endSec)} UTC;{' '}
            {dataset.events.length.toLocaleString()} sampled
            {dataset.unaskable > 0 && `, ${dataset.unaskable} more left out because their candles do not make a question`}.
            {summary !== null && ` Compared on ${summary.compared.toLocaleString()} of ${summary.sampled.toLocaleString()}: the events every model has answered.`}
          </p>
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

          <Card title="The same events with no model, and with the models combined">
            <ResultsTable title="Rule" rows={[...summary.baselines, ...summary.rules]} models={false} />
            <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
              The first two rows take every {summary.baselinesOver === 'compared' ? 'compared' : 'sampled'} event with one fixed
              bracket and no judgement: with the move, and against it
              {summary.baselinesOver === 'sampled' && ' (no model has answered yet, so there is nothing to compare them on: this is what the events did on their own)'}
              . research/EVENTS.md scored both over years and found each loses about a round trip&apos;s cost; a model is worth its
              price by as much as it beats them here. The rest are worked out from the answers above and cost nothing: what would
              have been traded had a side needed more than half the models, all of them, or the weight of their confidence, using
              the levels of the model surest of that side and waiting for the slowest answer.
            </p>
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
