import { useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { EXCHANGES, INTERVAL_SECONDS, type Candle, type Exchange, type SymbolInfo } from '../../shared/ipc'
import {
  AI_PROVIDER_LABEL,
  GPT_INTRADAY_INTERVAL,
  GPT_LOOKBACK_BARS,
  GPT_MIN_CONFIDENCE,
  type AiSignalDecision
} from '../../shared/aiSignal'
import { AI_ROUND_TRIP_COST_PCT } from '../../shared/aiContext'
import { AI_PANEL_CALLS, describeDecider, isPanelId, panelIdFor } from '../../shared/aiPanel'
import { describeEscalation } from '../../shared/aiRoute'
import { budgetProblem, describeAiBenchmarkCost, formatUsd, type AiConfig } from '../../shared/aiCost'
import { MIN_SCORED_CALLS, OUTCOME_PRIMARY_BARS, type AiCalibrationBucket } from '../../shared/aiOutcome'
import {
  AI_BENCHMARK_DEFAULT_DAYS,
  AI_BENCHMARK_DEFAULT_SPACING_BARS,
  AI_BENCHMARK_MAX_DECISIONS,
  AI_BENCHMARK_MAX_MODELS,
  AI_BENCHMARK_PERIOD_DAYS,
  AI_BENCHMARK_SPACING_BARS,
  benchmarkSampleTimes,
  summarizeBenchmark,
  summarizeBenchmarkRoutes,
  usableBenchmarkTimes,
  type AiBenchmarkAnswers,
  type AiBenchmarkModelRow,
  type AiBenchmarkSummary
} from '../../shared/aiBenchmark'
import { fetchRangeCached } from '../bots/candleCache'
import { formatUtcDate, formatUtcTime } from '../backtest/formatTradeTime'
import { describeError } from '../utils/ipcError'
import {
  BENCHMARK_CONCURRENCY,
  BENCHMARK_MAX_CONSECUTIVE_FAILURES,
  BENCHMARK_MAX_CONSECUTIVE_REFUSALS,
  benchmarkAskRequest,
  benchmarkPeekCandles,
  runBenchmark
} from './benchmark'
import { EventBenchmarkView } from './EventBenchmarkView'
import { buttonStyle, cellStyle, headCellStyle, horizonLabel, inputStyle, noteStyle, recommendationColor, signedPct } from './agentStyles'

const INTERVAL = GPT_INTRADAY_INTERVAL
const BAR_SEC = INTERVAL_SECONDS[INTERVAL]
/** Extra bars fetched before the first lookback, so a candle or two missing on the exchange's side
 * does not leave the oldest sampled decision one bar short. */
const FETCH_SLACK_BARS = 16
/** The comparison is redrawn at most this often while a run is filling it in. */
const REDRAW_MS = 1000
const HORIZON = horizonLabel(OUTCOME_PRIMARY_BARS, INTERVAL)

type Phase =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'running'; asked: number; toAsk: number; costUsd: number }
  | { status: 'error'; message: string }

interface Note {
  text: string
  bad: boolean
}

interface Shown {
  symbol: string
  everyBars: number
  models: string[]
  times: number[]
  /** Sampled candles this market could not be asked about. */
  missing: number
  summary: AiBenchmarkSummary
  /** What the summary was drawn from, kept so a route between two of the models can be worked out
   * from the same answers without asking for anything. */
  candles: Candle[]
  answers: AiBenchmarkAnswers
  notes: Note[]
}

interface ModelPair {
  first: string
  second: string
}

function hitRateText(row: AiBenchmarkModelRow): string {
  if (row.hitRatePct === null || row.hitRateMarginPct === null) return `too few (${row.hits} of ${row.scored})`
  return `${row.hitRatePct.toFixed(0)}% ± ${row.hitRateMarginPct.toFixed(0)} (${row.hits} of ${row.scored})`
}

function calibrationText(buckets: AiCalibrationBucket[]): string {
  const filled = buckets.filter((bucket) => bucket.scored > 0)
  if (filled.length === 0) return '—'
  return filled
    .map(
      (bucket) =>
        `${bucket.from.toFixed(1)}–${bucket.to.toFixed(1)}: ${bucket.hitRatePct !== null ? `${bucket.hitRatePct.toFixed(0)}%` : 'too few'} (${bucket.scored})`
    )
    .join(' · ')
}

function callText(decision: AiSignalDecision | null): { text: string; color: string } {
  if (decision === null) return { text: '—', color: 'var(--text-muted)' }
  if (decision.rejected) return { text: 'refused', color: 'var(--down)' }
  return {
    text: `${decision.recommendation.toUpperCase()} ${(decision.confidence * 100).toFixed(0)}%`,
    color: recommendationColor(decision.recommendation)
  }
}

function stamp(unixSeconds: number): string {
  return `${formatUtcDate(unixSeconds)} ${formatUtcTime(unixSeconds)}`
}

function CallsTable({ summary }: { summary: AiBenchmarkSummary }): React.JSX.Element {
  const rows = [...summary.models.map((row) => ({ row, baseline: false })), { row: summary.baseline, baseline: true }]
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headCellStyle}>Model</th>
            <th style={headCellStyle}>Answered</th>
            <th style={headCellStyle}>Refused</th>
            <th style={headCellStyle}>Buy</th>
            <th style={headCellStyle}>Sell</th>
            <th style={headCellStyle}>Hold</th>
            <th style={headCellStyle}>Right at {HORIZON}</th>
            <th style={headCellStyle}>Mean move after a buy</th>
            <th style={headCellStyle}>Avg. best / worst inside {HORIZON}</th>
            <th style={headCellStyle}>Right, by confidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, baseline }) => {
            const best = signedPct(row.meanBestPct)
            const worst = signedPct(row.meanWorstPct)
            const move = signedPct(row.meanBuyReturnPct)
            const tone = baseline ? 'var(--text-secondary)' : 'var(--text-primary)'
            return (
              <tr key={row.model}>
                <td style={{ ...cellStyle, fontWeight: 600, color: tone }}>{describeDecider(row.model)}</td>
                <td style={{ ...cellStyle, color: !baseline && row.answered < summary.sampled ? 'var(--down)' : tone }}>
                  {baseline ? '—' : `${row.answered} of ${summary.sampled}`}
                </td>
                <td style={{ ...cellStyle, color: row.refused > 0 ? 'var(--down)' : tone }}>{baseline ? '—' : row.refused}</td>
                <td style={{ ...cellStyle, color: tone }}>{row.buys}</td>
                <td style={{ ...cellStyle, color: tone }}>{baseline ? '—' : row.sells}</td>
                <td style={{ ...cellStyle, color: tone }}>{baseline ? '—' : row.holds}</td>
                <td style={{ ...cellStyle, color: tone }}>{hitRateText(row)}</td>
                <td style={{ ...cellStyle, color: move.color }}>{move.text}</td>
                <td style={cellStyle}>
                  <span style={{ color: best.color }}>{best.text}</span>
                  <span style={{ color: 'var(--text-muted)' }}> / </span>
                  <span style={{ color: worst.color }}>{worst.text}</span>
                </td>
                <td style={{ ...cellStyle, whiteSpace: 'normal', color: 'var(--text-secondary)' }}>
                  {/* The baseline is always fully confident, so its one bucket says nothing. */}
                  {baseline ? '—' : calibrationText(row.calibration)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TradingTable({ summary }: { summary: AiBenchmarkSummary }): React.JSX.Element {
  const rows = [...summary.models.map((row) => ({ row, baseline: false })), { row: summary.baseline, baseline: true }]
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headCellStyle}>Model</th>
            <th style={headCellStyle}>Entries</th>
            <th style={headCellStyle}>Trades held</th>
            <th style={headCellStyle}>Won</th>
            <th style={headCellStyle}>Return after costs</th>
            <th style={headCellStyle}>Max drawdown</th>
            <th style={headCellStyle}>Median latency</th>
            <th style={headCellStyle}>Cost per answer</th>
            <th style={headCellStyle}>Cost of these answers</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, baseline }) => {
            const traded = row.held.trades > 0
            const result = signedPct(traded ? row.held.returnPct : null)
            const tone = baseline ? 'var(--text-secondary)' : 'var(--text-primary)'
            return (
              <tr key={row.model}>
                <td style={{ ...cellStyle, fontWeight: 600, color: tone }}>{describeDecider(row.model)}</td>
                <td style={{ ...cellStyle, color: tone }}>{row.entries}</td>
                <td style={{ ...cellStyle, color: tone }}>{row.held.trades}</td>
                <td style={{ ...cellStyle, color: tone }}>{traded ? `${row.held.wins} of ${row.held.trades}` : '—'}</td>
                <td style={{ ...cellStyle, color: result.color }}>{result.text}</td>
                <td style={{ ...cellStyle, color: traded && row.held.maxDrawdownPct > 0 ? 'var(--down)' : 'var(--text-muted)' }}>
                  {traded ? `${row.held.maxDrawdownPct.toFixed(2)}%` : '—'}
                </td>
                <td style={{ ...cellStyle, color: tone }}>
                  {row.medianLatencyMs !== null ? `${(row.medianLatencyMs / 1000).toFixed(1)}s` : '—'}
                </td>
                <td style={{ ...cellStyle, color: tone }}>{row.costPerCallUsd !== null ? formatUsd(row.costPerCallUsd) : '—'}</td>
                <td style={{ ...cellStyle, color: tone }}>{row.costUsd !== null ? formatUsd(row.costUsd) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Two of a benchmark's models as a route, beside each of them alone.
 *
 * NOTHING IS ASKED HERE. A route's second model is put the same question as its first, so what a
 * route would have decided at each candle is already in the answers the tables above are drawn
 * from. Choosing a pair recomputes; it never spends. */
function RoutesCard({ shown, preferred }: { shown: Shown; preferred: ModelPair | null }): React.JSX.Element {
  const [picked, setPicked] = useState<ModelPair | null>(null)
  const { models, summary } = shown
  const usable = (pair: ModelPair | null): pair is ModelPair =>
    pair !== null && pair.first !== pair.second && models.includes(pair.first) && models.includes(pair.second)
  // What was picked while it still names two models of THIS benchmark, else the route that is set
  // under Models, else the first two listed.
  const pair = usable(picked) ? picked : usable(preferred) ? preferred : { first: models[0], second: models[1] }
  const routes = useMemo(
    () => summarizeBenchmarkRoutes({ candles: shown.candles, times: shown.times, models: shown.models, answers: shown.answers }, pair.first, pair.second),
    [shown, pair.first, pair.second]
  )

  const alone = (model: string): AiBenchmarkModelRow | undefined => summary.models.find((row) => row.model === model)
  const rows: { label: string; passedOn: string; row: AiBenchmarkModelRow | undefined; routed: boolean }[] = [
    { label: `${describeDecider(pair.first)} alone`, passedOn: '—', row: alone(pair.first), routed: false },
    { label: `${describeDecider(pair.second)} alone`, passedOn: '—', row: alone(pair.second), routed: false },
    ...routes.routes.map((route) => ({
      label: `${describeDecider(pair.first)}, then ${describeDecider(pair.second)} when it ${describeEscalation(route.when)}`,
      passedOn: `${route.escalated} of ${summary.compared} (${summary.compared > 0 ? ((route.escalated / summary.compared) * 100).toFixed(0) : 0}%)`,
      row: route.row,
      routed: true
    }))
  ]

  const choose = (slot: keyof ModelPair, model: string): void => {
    const other = slot === 'first' ? 'second' : 'first'
    // Picking the model the other slot holds swaps them, rather than leaving a route of one model.
    setPicked({ ...pair, [slot]: model, ...(pair[other] === model ? { [other]: pair[slot] } : {}) } as ModelPair)
  }

  return (
    <Card title="Two of them as a route">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
        <span style={{ ...noteStyle, color: 'var(--text-secondary)' }}>Asked every time</span>
        <select value={pair.first} onChange={(event) => choose('first', event.target.value)} style={inputStyle()} aria-label="First model of the route">
          {models.map((model) => (
            <option key={model} value={model}>
              {describeDecider(model)}
            </option>
          ))}
        </select>
        <span style={{ ...noteStyle, color: 'var(--text-secondary)' }}>passed on to</span>
        <select value={pair.second} onChange={(event) => choose('second', event.target.value)} style={inputStyle()} aria-label="Second model of the route">
          {models.map((model) => (
            <option key={model} value={model}>
              {describeDecider(model)}
            </option>
          ))}
        </select>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headCellStyle}>Asked</th>
              <th style={headCellStyle}>Passed on</th>
              <th style={headCellStyle}>Entries</th>
              <th style={headCellStyle}>Right at {HORIZON}</th>
              <th style={headCellStyle}>Trades held</th>
              <th style={headCellStyle}>Won</th>
              <th style={headCellStyle}>Return after costs</th>
              <th style={headCellStyle}>Max drawdown</th>
              <th style={headCellStyle}>Cost per decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, passedOn, row, routed }) => {
              if (row === undefined) return null
              const traded = row.held.trades > 0
              const result = signedPct(traded ? row.held.returnPct : null)
              const tone = routed ? 'var(--text-primary)' : 'var(--text-secondary)'
              return (
                <tr key={label}>
                  <td style={{ ...cellStyle, fontWeight: 600, color: tone, whiteSpace: 'normal' }}>{label}</td>
                  <td style={{ ...cellStyle, color: tone }}>{passedOn}</td>
                  <td style={{ ...cellStyle, color: tone }}>{row.entries}</td>
                  <td style={{ ...cellStyle, color: tone }}>{hitRateText(row)}</td>
                  <td style={{ ...cellStyle, color: tone }}>{row.held.trades}</td>
                  <td style={{ ...cellStyle, color: tone }}>{traded ? `${row.held.wins} of ${row.held.trades}` : '—'}</td>
                  <td style={{ ...cellStyle, color: result.color }}>{result.text}</td>
                  <td style={{ ...cellStyle, color: traded && row.held.maxDrawdownPct > 0 ? 'var(--down)' : 'var(--text-muted)' }}>
                    {traded ? `${row.held.maxDrawdownPct.toFixed(2)}%` : '—'}
                  </td>
                  <td style={{ ...cellStyle, color: tone }}>{row.costPerCallUsd !== null ? formatUsd(row.costPerCallUsd) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
        Worked out from the answers above, so looking at it costs nothing. A route asks its first model at every decision
        and passes the decision on to the second only when the rule says so; the second is asked the same question, and
        its answer is then the one that counts. Every row is scored on the same {summary.compared.toLocaleString()}{' '}
        decisions. Cost per decision is the first model&apos;s answer plus the second&apos;s wherever the decision was passed on.
        Every question in a benchmark is asked with the account holding nothing, so here “wants to open or close a
        position” can only mean an entry: this shows how a route would have chosen entries, not exits. What a second
        opinion adds depends on how differently the two models err (research/gptroute.ts); the table below says how
        often they made the same call. A route is set under Models.
      </p>
    </Card>
  )
}

function BenchmarkResult({ shown, preferredRoute }: { shown: Shown; preferredRoute: ModelPair | null }): React.JSX.Element {
  const [showDecisions, setShowDecisions] = useState(false)
  const { summary } = shown
  const spacing = horizonLabel(shown.everyBars, INTERVAL)
  const first = shown.times[0]
  const last = shown.times[shown.times.length - 1]
  const hold = signedPct(summary.buyAndHoldPct)

  return (
    <>
      <Card title="How each model's calls turned out">
        <p style={{ ...noteStyle, color: 'var(--text-secondary)', marginBottom: '0.6rem' }}>
          {shown.symbol} · {summary.sampled.toLocaleString()} decisions, one every {spacing}, from {stamp(first)} to {stamp(last)} UTC,
          each asked of every model with the account holding nothing. Compared on {summary.compared.toLocaleString()} of{' '}
          {summary.sampled.toLocaleString()}: the decisions every model has answered.
          {shown.missing > 0 &&
            ` ${shown.missing} sampled candle${shown.missing === 1 ? ' is' : 's are'} missing from this exchange's history, or ${
              shown.missing === 1 ? 'has' : 'have'
            } less than seven days of candles before ${shown.missing === 1 ? 'it' : 'them'}, and ${shown.missing === 1 ? 'was' : 'were'} left out.`}
        </p>
        {shown.notes.map((note) => (
          <p key={note.text} style={{ ...noteStyle, color: note.bad ? 'var(--down)' : 'var(--text-secondary)', marginBottom: '0.6rem' }}>
            {note.text}
          </p>
        ))}
        {summary.compared === 0 ? (
          <p style={noteStyle}>No decision has been answered by every model yet, so there is nothing to compare.</p>
        ) : (
          <CallsTable summary={summary} />
        )}
        <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
          A buy counts as right when, {HORIZON} after the candle it would have filled on, price is more than {AI_ROUND_TRIP_COST_PCT}%
          higher, which is what a round trip costs; a sell counts as right when price is lower. A hold makes no claim. “
          {summary.baseline.model}” is the market itself on these candles: a hit rate is only worth something above that row&apos;s, and
          research/gptneed.ts and gptcadence.ts measured that GPT Intraday needs roughly 67–75% right at this horizon to break
          even, depending on how often it is asked and how often it acts. ± is a 95% margin on the hit rate, in points: two
          models whose ranges overlap have not been told apart. A hit rate is withheld under {MIN_SCORED_CALLS} scored calls.
        </p>
        {shown.everyBars < OUTCOME_PRIMARY_BARS && (
          <p style={{ ...noteStyle, color: 'var(--gold)', marginTop: '0.5rem' }}>
            These decisions are {spacing} apart and each is scored over {HORIZON}, so neighbouring calls share most of their
            outcome. They are not independent, and the true margins are wider than the ones shown.
          </p>
        )}
      </Card>

      {summary.compared > 0 && (
        <Card title="Trading on them, and what asking cost">
          <TradingTable summary={summary} />
          <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
            Entries are buys at {(GPT_MIN_CONFIDENCE * 100).toFixed(0)}% confidence or more, the ones a GPT Intraday bot acts on.
            “Trades held” takes each entry at its candle&apos;s close and holds it for {HORIZON}, passes over an entry that arrives
            while one is still held, and pays {AI_ROUND_TRIP_COST_PCT}% a trade. It is the same simple path for every model, not
            the bot&apos;s own exits, and the drawdown counts the worst price inside each hold.
            {summary.buyAndHoldPct !== null && (
              <>
                {' '}
                Buying once at the first decision and holding to the end would have made{' '}
                <span style={{ color: hold.color }}>{hold.text}</span>.
              </>
            )}{' '}
            Latency and cost are of the compared answers as they were first asked, so an answer served from the cache today
            still counts what it cost then. A panel&apos;s answer is its four calls together, one after another.
          </p>
        </Card>
      )}

      {shown.models.length >= 2 && summary.compared > 0 && <RoutesCard shown={shown} preferred={preferredRoute} />}

      {summary.agreement.length > 0 && summary.compared > 0 && (
        <Card title="How often two models made the same call">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>Models</th>
                  <th style={headCellStyle}>Same call</th>
                </tr>
              </thead>
              <tbody>
                {summary.agreement.map((pair) => (
                  <tr key={`${pair.a}|${pair.b}`}>
                    <td style={cellStyle}>
                      {describeDecider(pair.a)} <span style={{ color: 'var(--text-muted)' }}>and</span> {describeDecider(pair.b)}
                    </td>
                    <td style={cellStyle}>
                      {pair.both > 0 ? `${((pair.same / pair.both) * 100).toFixed(0)}% (${pair.same} of ${pair.both})` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
            {summary.unanimous !== null &&
              `Every model made the same call on ${summary.unanimous.toLocaleString()} of the ${summary.compared.toLocaleString()} compared decisions. `}
            Agreement is not evidence of being right: models that agree nearly always are one opinion, not several, and the
            table above is where each is scored.
          </p>
        </Card>
      )}

      <Card
        title="Every decision"
        actions={
          <button onClick={() => setShowDecisions((open) => !open)} style={buttonStyle('secondary')}>
            {showDecisions ? 'Hide' : `Show all ${summary.sampled.toLocaleString()}`}
          </button>
        }
      >
        {!showDecisions ? (
          <p style={noteStyle}>Each sampled candle, what every model said about it, and what price did next.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>Candle (UTC)</th>
                  <th style={headCellStyle}>Fill price</th>
                  <th style={headCellStyle}>+{HORIZON}</th>
                  {shown.models.map((model) => (
                    <th key={model} style={headCellStyle}>
                      {describeDecider(model)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.decisions.map((decision) => {
                  const move = signedPct(decision.primaryReturnPct)
                  return (
                    <tr
                      key={decision.time}
                      style={{ opacity: decision.compared ? 1 : 0.55 }}
                      title={decision.compared ? undefined : 'Not every model has answered this one, so it is left out of the comparison.'}
                    >
                      <td style={cellStyle}>{stamp(decision.time)}</td>
                      <td style={cellStyle}>{decision.referencePrice !== null ? decision.referencePrice.toLocaleString() : '—'}</td>
                      <td style={{ ...cellStyle, color: move.color }}>{move.text}</td>
                      {decision.calls.map((call, position) => {
                        const said = callText(call)
                        return (
                          <td
                            key={shown.models[position]}
                            style={{ ...cellStyle, color: said.color, fontWeight: 600 }}
                            title={call?.rejected ?? call?.rationale ?? undefined}
                          >
                            {said.text}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

/** Two benchmarks share this tab. They ask different questions and are scored differently, so
 * each is its own screen: one market on a clock, scored by where the price was four hours later;
 * and the events the scanner raises across the market, scored by following each recommendation
 * (EventBenchmarkView.tsx). Neither is mounted while the other is shown. */
export function BenchmarkTab(): React.JSX.Element {
  const [mode, setMode] = useState<'clock' | 'events'>('clock')
  return (
    <>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button onClick={() => setMode('clock')} style={buttonStyle(mode === 'clock' ? 'primary' : 'secondary')} aria-pressed={mode === 'clock'}>
          One market on a clock
        </button>
        <button onClick={() => setMode('events')} style={buttonStyle(mode === 'events' ? 'primary' : 'secondary')} aria-pressed={mode === 'events'}>
          Events across the market
        </button>
      </div>
      {mode === 'clock' ? <ClockBenchmark /> : <EventBenchmarkView />}
    </>
  )
}

/** The same questions put to several models, and the answers scored side by side.
 *
 * PRESSING RUN SPENDS NOTHING BY ITSELF. It fetches candles and reads the decision cache, and only
 * then -- if any answer is missing -- says what the rest would cost, per model, and asks. A
 * benchmark that is already paid for is simply shown. */
function ClockBenchmark(): React.JSX.Element {
  const [exchange, setExchange] = useState<Exchange>('binance')
  const [pair, setPair] = useState<SymbolInfo>(EXCHANGES[0].defaultSymbol)
  const [days, setDays] = useState<number>(AI_BENCHMARK_DEFAULT_DAYS)
  const [everyBars, setEveryBars] = useState<number>(AI_BENCHMARK_DEFAULT_SPACING_BARS)
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [phase, setPhase] = useState<Phase>({ status: 'idle' })
  const [shown, setShown] = useState<Shown | null>(null)
  const runIdRef = useRef(0)
  const stopRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void window.api.ai.getConfig().then((next) => {
      if (cancelled) return
      setConfig(next)
      setChosen(next.enabledModels.slice(0, AI_BENCHMARK_MAX_MODELS))
    })
    return (): void => {
      cancelled = true
    }
  }, [])

  // Leaving the tab ends the run: nothing is asked for on a page nobody is looking at. Whatever
  // was answered is cached, so coming back and running it again carries on from there.
  useEffect(
    () => (): void => {
      runIdRef.current++
    },
    []
  )

  const planned = Math.floor((days * 86_400) / (everyBars * BAR_SEC))
  const tooMany = planned > AI_BENCHMARK_MAX_DECISIONS
  const busy = phase.status === 'checking' || phase.status === 'running'
  const blocked = busy || chosen.length === 0 || tooMany

  function toggleModel(model: string, on: boolean): void {
    setChosen((previous) => (on ? [...previous, model] : previous.filter((entry) => entry !== model)))
  }

  async function handleRun(): Promise<void> {
    if (blocked) return
    const runId = ++runIdRef.current
    const current = (): boolean => runIdRef.current === runId
    stopRef.current = false
    // In the order they are listed, whatever order they were ticked in: the models, then the panels.
    const enabled = config?.enabledModels ?? []
    const models = [...enabled, ...enabled.map(panelIdFor)].filter((model) => chosen.includes(model))
    const market = { exchange, symbol: pair.symbol }
    setPhase({ status: 'checking' })
    setShown(null)

    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const sampled = benchmarkSampleTimes({ nowSec, days, everyBars, interval: INTERVAL })
      // Fetched up to NOW, not to the last sampled candle: the shared cache refreshes its newest
      // bar only when asked for it, and a benchmark must never score against a bar that was still
      // forming when it was stored.
      const fetched = await fetchRangeCached(
        (ex, sym, iv, from, to) => window.api.market.fetchHistoricalRange(ex, sym, iv, from, to),
        exchange,
        pair.symbol,
        INTERVAL,
        sampled[0] - (GPT_LOOKBACK_BARS + FETCH_SLACK_BARS) * BAR_SEC,
        nowSec
      )
      if (!current()) return
      const candles = fetched.filter((candle) => candle.time + BAR_SEC <= nowSec)
      const { times, missing } = usableBenchmarkTimes(candles, sampled)
      if (times.length === 0) {
        throw new Error('This market does not have enough 15-minute history to benchmark over this period.')
      }

      // FREE FIRST. Which answers are already held, and what one more call to each model costs.
      const peek = await window.api.ai.peekBenchmark({
        exchange,
        symbol: pair.symbol,
        interval: INTERVAL,
        candles: benchmarkPeekCandles(candles, times),
        times,
        models
      })
      if (!current()) return

      const show = (answers: AiBenchmarkAnswers, notes: Note[]): void => {
        // A run fills `answers` in place. The copy keeps the routes card on the very answers the
        // summary beside it was drawn from, however many more arrive before the next redraw.
        const held: AiBenchmarkAnswers = Object.fromEntries(Object.entries(answers).map(([model, list]) => [model, [...list]]))
        setShown({
          symbol: pair.symbol,
          everyBars,
          models,
          times,
          missing,
          summary: summarizeBenchmark({ candles, times, models, answers: held }),
          candles,
          answers: held,
          notes
        })
      }

      let answers: AiBenchmarkAnswers = Object.fromEntries(peek.models.map((entry) => [entry.model, entry.decisions]))
      const costModels = peek.models.map((entry) => {
        const cached = entry.decisions.filter((decision) => decision !== null).length
        return {
          model: entry.model,
          cached,
          toAsk: times.length - cached,
          perCallCostUsd: entry.perCallCostUsd,
          perCallLatencyMs: entry.perCallLatencyMs ?? null,
          costBasis: entry.costBasis,
          callsPerAnswer: entry.callsPerAnswer
        }
      })
      const toAsk = costModels.reduce((sum, entry) => sum + entry.toAsk, 0)
      const held = times.length * models.length - toAsk
      const notes: Note[] = []

      if (toAsk === 0) {
        notes.push({ text: 'Every answer was already cached, so nothing was asked and nothing was spent.', bad: false })
      } else {
        const fresh = await window.api.ai.getConfig()
        if (!current()) return
        const problem = budgetProblem(fresh.dailyCapUsd, fresh.spentTodayUsd)
        const onlyCached = `Showing only what was already cached: ${held.toLocaleString()} of ${(times.length * models.length).toLocaleString()} answers.`
        if (problem !== null) {
          notes.push({ text: `Nothing was asked. ${problem} ${onlyCached}`, bad: true })
        } else if (
          !window.confirm(
            describeAiBenchmarkCost({
              symbol: pair.symbol,
              decisions: times.length,
              models: costModels,
              budgetRemainingUsd: peek.budgetRemainingUsd,
              concurrency: BENCHMARK_CONCURRENCY,
              callsPerMinute: fresh.callsPerMinute
            })
          )
        ) {
          notes.push({ text: `Nothing was asked. ${onlyCached}`, bad: false })
        } else {
          const indexByTime = new Map(candles.map((candle, index) => [candle.time, index]))
          setPhase({ status: 'running', asked: 0, toAsk, costUsd: 0 })
          let drawnAt = 0
          // Counted from what each tape says it made: an answer is one call from a model and up
          // to four from a panel, and fewer when part of it was already held.
          let callsMade = 0
          const result = await runBenchmark({
            times,
            models,
            known: answers,
            ask: async (model, timeIndex) => {
              const tape = await window.api.ai.generateSignalTape(
                benchmarkAskRequest(market, candles, indexByTime.get(times[timeIndex]) ?? -1, model)
              )
              callsMade += tape.callCount
              const decision = tape.decisions[0]
              if (decision === undefined) throw new Error('No decision came back for this candle.')
              return decision
            },
            shouldStop: () => !current() || stopRef.current,
            onProgress: (progress, soFar) => {
              if (!current()) return
              setPhase({ status: 'running', ...progress })
              if (performance.now() - drawnAt < REDRAW_MS) return
              drawnAt = performance.now()
              show(soFar, [{ text: 'Still running: the table fills in as answers arrive.', bad: false }])
            }
          })
          if (!current()) return
          answers = result.answers

          const unanswered = result.asked - result.answered
          notes.push({
            text:
              `This run made ${callsMade.toLocaleString()} model call${callsMade === 1 ? '' : 's'} and spent ${formatUsd(result.costUsd)}.` +
              (unanswered > 0
                ? ` ${unanswered} answer${unanswered === 1 ? '' : 's'} did not come back; ${unanswered === 1 ? 'it is' : 'they are'} not cached and will be asked for again next time.`
                : ''),
            bad: false
          })
          for (const drop of result.dropped) {
            notes.push({
              text: drop.refused
                ? `Stopped asking ${describeDecider(drop.model)} after ${BENCHMARK_MAX_CONSECUTIVE_REFUSALS} of its answers in a row were refused, each of them billed. It answers, but not in the shape asked for: ${drop.error}`
                : `Stopped asking ${describeDecider(drop.model)} after ${BENCHMARK_MAX_CONSECUTIVE_FAILURES} answers in a row failed. Last error: ${drop.error}`,
              bad: true
            })
          }
          if (result.stopped?.reason === 'refused') {
            // The reason is the main process's own sentence, and for the budget it already says
            // that nothing is lost. What it cannot know is what a benchmark does next.
            notes.push({
              text: `The run stopped early. ${result.stopped.message ?? ''} Running the benchmark again asks only for what is missing.`,
              bad: true
            })
          } else if (result.stopped?.reason === 'cancelled') {
            notes.push({
              text: 'Stopped before everything was asked. What was answered is cached; run the benchmark again to carry on.',
              bad: false
            })
          }
        }
      }

      show(answers, notes)
      setPhase({ status: 'idle' })
    } catch (failure) {
      if (current()) setPhase({ status: 'error', message: describeError(failure) })
    }
  }

  return (
    <>
      <Card title="Compare models on the same questions">
        <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
          Puts the same questions to every model you tick: at each sampled {INTERVAL} candle, the seven days before it, with
          the account holding nothing. That is the question a GPT Intraday bot or backtest asks while it is flat, so answers
          are shared with them through the cache. Each call is then scored against the {HORIZON} that followed. Asking costs
          money through {AI_PROVIDER_LABEL} the first time only; you are shown the price for each model before anything is
          asked, and nothing here can place an order. A panel of agents on a model can be ticked beside the model itself:
          it is asked the same questions with {AI_PANEL_CALLS} calls an answer, so the table says whether it did any better
          for the price.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
          <ExchangeSelect
            exchange={exchange}
            onSelect={(next) => {
              setExchange(next)
              setPair(EXCHANGES.find((entry) => entry.id === next)?.defaultSymbol ?? pair)
            }}
          />
          <SymbolSearch exchange={exchange} symbol={pair.symbol} onSelect={setPair} />
          <select value={days} onChange={(event) => setDays(Number(event.target.value))} disabled={busy} style={inputStyle()} aria-label="Period">
            {AI_BENCHMARK_PERIOD_DAYS.map((value) => (
              <option key={value} value={value}>
                Last {value} days
              </option>
            ))}
          </select>
          <select
            value={everyBars}
            onChange={(event) => setEveryBars(Number(event.target.value))}
            disabled={busy}
            style={inputStyle()}
            aria-label="Spacing"
          >
            {AI_BENCHMARK_SPACING_BARS.map((value) => (
              <option key={value} value={value}>
                One decision every {horizonLabel(value, INTERVAL)}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.8rem' }}>
          {(config?.enabledModels ?? []).map((model) => {
            const on = chosen.includes(model)
            return (
              <label
                key={model}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy || (!on && chosen.length >= AI_BENCHMARK_MAX_MODELS)}
                  onChange={(event) => toggleModel(model, event.target.checked)}
                />
                {model}
                {model === config?.defaultModel && <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>default</span>}
              </label>
            )
          })}
          {(config?.enabledModels ?? []).map(panelIdFor).map((panel) => {
            const on = chosen.includes(panel)
            return (
              <label
                key={panel}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy || (!on && chosen.length >= AI_BENCHMARK_MAX_MODELS)}
                  onChange={(event) => toggleModel(panel, event.target.checked)}
                />
                {describeDecider(panel)}
                <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{AI_PANEL_CALLS} calls an answer</span>
              </label>
            )
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <button onClick={() => void handleRun()} disabled={blocked} style={buttonStyle('primary', blocked)}>
            {phase.status === 'checking' ? 'Checking the cache…' : phase.status === 'running' ? 'Running…' : 'Run benchmark'}
          </button>
          {phase.status === 'running' && (
            <button
              onClick={() => {
                stopRef.current = true
              }}
              style={buttonStyle('secondary')}
            >
              Stop
            </button>
          )}
          <span style={{ ...noteStyle, color: 'var(--text-secondary)' }}>
            {phase.status === 'running'
              ? `${phase.asked.toLocaleString()} of ${phase.toAsk.toLocaleString()} answers in · ${formatUsd(phase.costUsd)} spent · leaving this tab stops the run`
              : `${planned.toLocaleString()} decisions for each of ${
                  chosen.some(isPanelId) ? `the ${chosen.length} ticked` : `${chosen.length} model${chosen.length === 1 ? '' : 's'}`
                }: ${(planned * chosen.length).toLocaleString()} answers in all.`}
          </span>
        </div>

        {tooMany && (
          <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.7rem' }}>
            A benchmark asks at most {AI_BENCHMARK_MAX_DECISIONS} decisions of each model. Shorten the period or space the
            decisions further apart.
          </p>
        )}
        {config !== null && config.enabledModels.length < 2 && (
          <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
            Only one model is enabled, so it can be set beside the market and beside its own agent panel, but not beside
            another model. Enable more under Models.
          </p>
        )}
        {chosen.length === 0 && config !== null && <p style={{ ...noteStyle, marginTop: '0.7rem' }}>Tick at least one model or panel.</p>}
        {phase.status === 'error' && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.7rem' }}>{phase.message}</p>}
      </Card>

      {shown !== null && (
        <BenchmarkResult
          shown={shown}
          preferredRoute={config?.route ? { first: config.defaultModel, second: config.route.model } : null}
        />
      )}
    </>
  )
}
