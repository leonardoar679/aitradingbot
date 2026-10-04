import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { INTERVAL_SECONDS, type Candle } from '../../shared/ipc'
import type { AiCallRecord } from '../../shared/aiLedger'
import { formatUsd } from '../../shared/aiCost'
import { AI_ROUND_TRIP_COST_PCT } from '../../shared/aiContext'
import { describeAgentFinding, describeDecider, panelIdFor } from '../../shared/aiPanel'
import {
  MIN_SCORED_CALLS,
  OUTCOME_HORIZON_BARS,
  OUTCOME_PRIMARY_BARS,
  scoreCalls,
  summarizeOutcomes,
  type AiBarrierOutcome,
  type AiOutcome
} from '../../shared/aiOutcome'
import { fetchRangeCached } from '../bots/candleCache'
import { STRATEGIES } from '../backtest/strategies'
import { formatUtcDate, formatUtcTime } from '../backtest/formatTradeTime'
import { describeError } from '../utils/ipcError'
import { buttonStyle, cellStyle, headCellStyle, horizonLabel, inputStyle, noteStyle, recommendationColor, signedPct } from './agentStyles'

const PAGE_ROWS = 500
/** The horizons given their own column. The shortest is left out: one bar is mostly noise. */
const SHOWN_HORIZONS = OUTCOME_HORIZON_BARS.filter((bars) => bars > 1)
const LONGEST_HORIZON = Math.max(...OUTCOME_HORIZON_BARS)

const BARRIER_LABEL: Record<AiBarrierOutcome, string> = {
  take_profit: 'target',
  stop_loss: 'stop',
  neither: 'neither',
  pending: 'pending',
  no_levels: '—'
}

function marketKey(row: AiCallRecord): string {
  return `${row.exchange}|${row.symbol}|${row.interval}`
}

/** Scores every row against the candles that followed it, one market at a time.
 *
 * COMPUTED HERE, ON DEMAND, AND NOT SAVED. An outcome is a function of a call and the market after
 * it, so it is derived each time it is looked at -- the same rule as every other simulated figure
 * in this app. The candles come through the shared cache, so a market already on screen elsewhere
 * costs nothing more to score. */
async function scoreAll(rows: AiCallRecord[]): Promise<Map<string, AiOutcome>> {
  const byMarket = new Map<string, AiCallRecord[]>()
  for (const row of rows) {
    const group = byMarket.get(marketKey(row))
    if (group) group.push(row)
    else byMarket.set(marketKey(row), [row])
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const outcomes = new Map<string, AiOutcome>()
  for (const group of byMarket.values()) {
    const { exchange, symbol, interval } = group[0]
    const barSec = INTERVAL_SECONDS[interval]
    const times = group.map((row) => row.candleTime)
    const fetched = await fetchRangeCached(
      (ex, sym, iv, from, to) => window.api.market.fetchHistoricalRange(ex, sym, iv, from, to),
      exchange,
      symbol,
      interval,
      Math.min(...times) - barSec,
      Math.min(nowSec, Math.max(...times) + (LONGEST_HORIZON + 1) * barSec)
    )
    // The last bar an exchange returns is still forming. Its close is not a fact yet, so a return
    // measured to it would change on the next refresh; only closed bars are scored against.
    const closed: Candle[] = fetched.filter((candle) => candle.time + barSec <= nowSec)
    for (const [id, outcome] of scoreCalls(group, closed)) outcomes.set(id, outcome)
  }
  return outcomes
}

/** Which calls to show. A review of a strategy's entry and a standalone signal answer different
 * questions on different bar sizes, so a hit rate over both together describes neither. A panel
 * analyst's report answers a third: it is a call that was paid for, and it made no call on the
 * market to score. */
type KindFilter = 'all' | 'signal' | 'review' | 'report'

function isReview(row: AiCallRecord): boolean {
  return row.strategyId !== undefined
}

/** A panel analyst's report, as opposed to the panel's decision or any other signal. */
function isReport(row: AiCallRecord): boolean {
  return row.agent !== undefined && row.agent !== 'decision'
}

function kindOf(row: AiCallRecord): Exclude<KindFilter, 'all'> {
  return isReview(row) ? 'review' : isReport(row) ? 'report' : 'signal'
}

/** Who a call's verdict belongs to. A panel's decision was made by the panel, not by its model
 * answering alone, and scoring the two under one name would average two different deciders. */
function scoredAs(row: AiCallRecord): string {
  return row.agent === 'decision' ? panelIdFor(row.model) : row.model
}

function modelLabel(row: AiCallRecord): string {
  if (row.agent === undefined) return row.model
  return row.agent === 'decision' ? `${row.model} · panel decision` : `${row.model} · ${row.agent} analyst`
}

function callLabel(row: AiCallRecord): string {
  if (row.status === 'failed') return 'failed'
  if (row.status === 'rejected') return 'refused'
  if (isReport(row) && row.agent !== 'decision' && row.agent !== undefined) return row.report ? describeAgentFinding(row.agent, row.report) : '—'
  // On a review the model was not asked what to do, only whether to let an entry through.
  if (isReview(row)) return row.recommendation === 'buy' ? 'confirm' : 'veto'
  return row.recommendation ?? '—'
}

/** Where a call came from, naming the strategy when it reviewed one's entry. */
function originLabel(row: AiCallRecord): string {
  // A route's second opinion: asked because of what another model had just said.
  if (row.escalatedFrom !== undefined) return `${row.source} · second opinion after ${row.escalatedFrom}`
  if (row.strategyId === undefined) return row.source
  const strategy = STRATEGIES.find((candidate) => candidate.id === row.strategyId)
  return `${row.source} · review of ${strategy?.name ?? row.strategyId}`
}

function verdict(row: AiCallRecord, outcome: AiOutcome | undefined, scoring: boolean): { text: string; color: string } {
  if (row.status !== 'ok') return { text: '—', color: 'var(--text-muted)' }
  // An analyst's report says what the market is doing, not what to do about it.
  if (row.recommendation === null) return { text: '—', color: 'var(--text-muted)' }
  if (row.recommendation === 'hold') return { text: 'no call', color: 'var(--text-muted)' }
  if (scoring) return { text: 'scoring', color: 'var(--text-muted)' }
  if (!outcome || outcome.correct === null) return { text: 'pending', color: 'var(--text-muted)' }
  return outcome.correct ? { text: 'right', color: 'var(--up)' } : { text: 'wrong', color: 'var(--down)' }
}

export function SignalsTab(): React.JSX.Element {
  const [rows, setRows] = useState<AiCallRecord[]>([])
  const [skipped, setSkipped] = useState(0)
  const [outcomes, setOutcomes] = useState<Map<string, AiOutcome>>(new Map())
  const [loading, setLoading] = useState(true)
  /** True from the moment the rows are on screen until their outcomes are. Kept apart from
   * `loading` because the two look alike and mean opposite things: an unscored call and a call
   * whose horizon has not closed are both blank, and only one of them will fill in by waiting. */
  const [scoring, setScoring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scoreError, setScoreError] = useState<string | null>(null)
  const [modelFilter, setModelFilter] = useState('')
  const [symbolFilter, setSymbolFilter] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    setScoreError(null)
    try {
      const page = await window.api.ai.listCalls({ limit: PAGE_ROWS })
      setRows(page.rows)
      setSkipped(page.skippedLines)
      setOutcomes(new Map())
      setScoring(true)
      try {
        setOutcomes(await scoreAll(page.rows.filter((row) => row.status === 'ok')))
      } catch (failure) {
        // The history is still worth showing when the exchange cannot be reached; it just cannot
        // be scored. Losing the whole table to a market-data failure would hide what was spent.
        setScoreError(describeError(failure))
      }
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setScoring(false)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const models = useMemo(() => [...new Set(rows.map((row) => row.model))].sort(), [rows])
  const symbols = useMemo(() => [...new Set(rows.map((row) => row.symbol))].sort(), [rows])
  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          (modelFilter === '' || row.model === modelFilter) &&
          (symbolFilter === '' || row.symbol === symbolFilter) &&
          (kindFilter === 'all' || kindOf(row) === kindFilter)
      ),
    [rows, modelFilter, symbolFilter, kindFilter]
  )
  const scores = useMemo(() => summarizeOutcomes(visible.map((row) => ({ ...row, model: scoredAs(row) })), outcomes), [visible, outcomes])
  const hasReviews = useMemo(() => rows.some(isReview), [rows])
  const hasReports = useMemo(() => rows.some(isReport), [rows])
  // A horizon is a count of the call's OWN bars: sixteen of them is four hours on 15-minute
  // candles and nearly three days on 4-hour ones. It is said as a duration only while every row
  // on screen shares one bar size; mixed, "+4h" over a 4h row would be wrong by a factor of 16.
  const sharedInterval = useMemo(() => {
    const intervals = new Set(visible.map((row) => row.interval))
    return intervals.size === 1 ? [...intervals][0] : null
  }, [visible])
  const horizonText = (bars: number): string => (sharedInterval !== null ? horizonLabel(bars, sharedInterval) : `${bars} bars`)

  return (
    <>
      <Card
        title="How each model's calls turned out"
        actions={
          <button onClick={() => void load()} disabled={loading} style={buttonStyle('secondary', loading)}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        }
      >
        <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
          Every answered call, scored against the candles that followed it. A buy counts as right when,{' '}
          {OUTCOME_PRIMARY_BARS} bars after the candle it executed on, price is more than {AI_ROUND_TRIP_COST_PCT}% higher,
          which is what a round trip costs; a sell counts as right when price is lower. {OUTCOME_PRIMARY_BARS} bars is{' '}
          {horizonLabel(OUTCOME_PRIMARY_BARS, '15m')} on 15-minute candles. A hold makes no claim and is not scored.
          research/gptneed.ts and gptcadence.ts measured that GPT Intraday needs roughly 67–75% of its calls right at
          that horizon just to break even, depending on how often it is asked, and that on every candle acting less
          often matters as much as being right. A hit rate is withheld until a model has {MIN_SCORED_CALLS} scored
          calls: below that it is mostly noise.
        </p>
        {hasReviews && (
          <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
            A review of a strategy&apos;s entry is scored the same way, on that strategy&apos;s own candles: a confirm is a buy and a
            veto makes no claim. What a vetoed entry would have made as a trade is on the Backtest page, in the run that asked.
            Use the filter below to keep reviews and standalone signals apart; together they are two different questions.
          </p>
        )}
        {hasReports && (
          <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
            A panel of agents is four calls a decision. Its three analysts&apos; reports are in the history below with what
            each cost, and are not scored: a report says what the market is doing, not what to do. The panel&apos;s decision
            is scored, under the panel&apos;s name rather than its model&apos;s, so the two can be told apart.
          </p>
        )}
        {error !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{error}</p>}
        {scoreError !== null && (
          <p style={{ ...noteStyle, color: 'var(--down)', marginBottom: '0.6rem' }}>
            The calls below could not be scored because market data did not load: {scoreError}
          </p>
        )}
        {scoring ? (
          // Not the table with zeros in it. Drawn before the candles arrive, every model reads
          // "0 scored, too few" -- a real-looking result that is only an unfinished one.
          <p style={noteStyle}>Scoring {rows.length.toLocaleString()} calls against the candles that followed them…</p>
        ) : scores.length === 0 ? (
          <p style={noteStyle}>{loading ? 'Loading…' : 'No answered calls yet. Analyze a market, or run a GPT Intraday backtest, and they appear here.'}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>Model</th>
                  <th style={headCellStyle}>Decisions</th>
                  <th style={headCellStyle}>Acted</th>
                  <th style={headCellStyle}>Scored</th>
                  <th style={headCellStyle}>Right</th>
                  <th style={headCellStyle}>Mean move after a buy</th>
                  <th style={headCellStyle}>Right, by confidence</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((score) => (
                  <tr key={score.model}>
                    <td style={{ ...cellStyle, fontWeight: 600 }}>{describeDecider(score.model)}</td>
                    <td style={cellStyle}>{score.decisions}</td>
                    <td style={cellStyle}>
                      {score.acted}
                      {score.actRatePct !== null && ` (${score.actRatePct.toFixed(0)}%)`}
                    </td>
                    <td style={cellStyle}>{score.scored}</td>
                    <td style={cellStyle}>
                      {score.hitRatePct !== null
                        ? `${score.hitRatePct.toFixed(0)}% (${score.hits} of ${score.scored})`
                        : `too few (${score.hits} of ${score.scored})`}
                    </td>
                    <td style={{ ...cellStyle, color: signedPct(score.meanBuyReturnPct).color }}>{signedPct(score.meanBuyReturnPct).text}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'normal', color: 'var(--text-secondary)' }}>
                      {score.calibration.filter((bucket) => bucket.scored > 0).length === 0
                        ? '—'
                        : score.calibration
                            .filter((bucket) => bucket.scored > 0)
                            .map(
                              (bucket) =>
                                `${bucket.from.toFixed(1)}–${bucket.to.toFixed(1)}: ${
                                  bucket.hitRatePct !== null ? `${bucket.hitRatePct.toFixed(0)}%` : 'too few'
                                } (${bucket.scored})`
                            )
                            .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Call history">
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
          <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} style={inputStyle()} aria-label="Model filter">
            <option value="">All models</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <select value={symbolFilter} onChange={(event) => setSymbolFilter(event.target.value)} style={inputStyle()} aria-label="Symbol filter">
            <option value="">All symbols</option>
            {symbols.map((symbol) => (
              <option key={symbol} value={symbol}>
                {symbol}
              </option>
            ))}
          </select>
          <select
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value as KindFilter)}
            style={inputStyle()}
            aria-label="Kind filter"
          >
            <option value="all">Every call</option>
            <option value="signal">Standalone signals</option>
            <option value="review">Entry reviews</option>
            <option value="report">Panel analysts&apos; reports</option>
          </select>
        </div>
        {skipped > 0 && (
          <p style={{ ...noteStyle, color: 'var(--down)', marginBottom: '0.6rem' }}>
            {skipped} ledger line{skipped === 1 ? '' : 's'} could not be read and {skipped === 1 ? 'is' : 'are'} missing from
            this table and its totals.
          </p>
        )}
        {visible.length === 0 ? (
          <p style={noteStyle}>{loading ? 'Loading…' : 'Nothing to show.'}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>Candle (UTC)</th>
                  <th style={headCellStyle}>Market</th>
                  <th style={headCellStyle}>Model</th>
                  <th style={headCellStyle}>Call</th>
                  <th style={headCellStyle}>Conf.</th>
                  <th style={headCellStyle}>Fill price</th>
                  {SHOWN_HORIZONS.map((bars) => (
                    <th key={bars} style={headCellStyle}>
                      +{horizonText(bars)}
                    </th>
                  ))}
                  <th style={headCellStyle}>Its levels</th>
                  <th style={headCellStyle}>Verdict</th>
                  <th style={headCellStyle}>Cost</th>
                  <th style={headCellStyle}>From</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const outcome = outcomes.get(row.id)
                  const result = verdict(row, outcome, scoring)
                  return (
                    <tr key={`${row.id}-${row.at}`} title={row.error ?? row.rationale ?? undefined}>
                      <td style={cellStyle}>
                        {formatUtcDate(row.candleTime)} {formatUtcTime(row.candleTime)}
                      </td>
                      <td style={cellStyle}>
                        {row.symbol} <span style={{ color: 'var(--text-muted)' }}>{row.interval}</span>
                      </td>
                      <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{modelLabel(row)}</td>
                      <td
                        style={{
                          ...cellStyle,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: row.status === 'ok' ? recommendationColor(row.recommendation) : 'var(--down)'
                        }}
                      >
                        {callLabel(row)}
                      </td>
                      <td style={cellStyle}>{row.confidence !== null ? `${(row.confidence * 100).toFixed(0)}%` : '—'}</td>
                      <td style={cellStyle}>{outcome?.referencePrice != null ? outcome.referencePrice.toLocaleString() : '—'}</td>
                      {SHOWN_HORIZONS.map((bars) => {
                        const move = signedPct(outcome?.forward.find((entry) => entry.bars === bars)?.returnPct ?? null)
                        return (
                          <td key={bars} style={{ ...cellStyle, color: move.color }}>
                            {move.text}
                          </td>
                        )
                      })}
                      <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{BARRIER_LABEL[outcome?.barrier ?? 'no_levels']}</td>
                      <td style={{ ...cellStyle, color: result.color, fontWeight: 600 }}>{result.text}</td>
                      <td style={cellStyle}>{row.usage.costUsd !== null ? formatUsd(row.usage.costUsd) : '—'}</td>
                      <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>{originLabel(row)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
          The newest {PAGE_ROWS} calls. Moves are measured from the close of the candle the decision executed on, which is
          the price a backtest fills at. Hover a row for the model&apos;s reasoning, or for why a call failed.
        </p>
      </Card>
    </>
  )
}
