import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { AI_ADDITION_PROMPT_VERSIONS, newsReadingsOf } from '../../shared/aiAdditions'
import { eventNewsOf } from '../../shared/aiHelp'
import type { AiCallRecord } from '../../shared/aiLedger'
import { isActionableOpportunity, opportunitySide } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import { roundTripFee } from '../../shared/fees'
import type { Candle, ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import type { MarketEvent } from '../../shared/marketEvent'
import { scoredSide, signalScore, type SignalCall } from '../../shared/opportunityScore'
import { attributedTrades, attribution, attributionCsv, type Attribution, type AttributionReadings, type NetSourceRow, type SliceRow } from '../../shared/performance/attribution'
import { RESEARCH_MIN_SLICE, RESEARCH_MIN_TRADES } from '../../shared/research/common'
import { loadLiveLabels } from '../agents/liveBoard'
import { cellStyle, headCellStyle, noteStyle, buttonStyle } from '../agents/agentStyles'
import { readTrade } from './sessionReport'

/** How far back the trades are read: the records the Research tab reads too. */
const DAYS = 90
const ROWS_READ = 5000
/** Minutes read after a trade's entry, beyond its plan's end, so that the end's close is there. */
const AFTER_END_SEC = 120

const pct = (value: number | null): string => (value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`)
const money = (value: number | null): string => (value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`)
const ratio = (value: number | null): string => (value === null ? '—' : value.toFixed(2))

/** What the readings are made from: the trades' events, the watch's calls on them, the stories'
 * marks, and each trade's minutes from its entry to its plan's end. Every read is of a record. */
async function readReadings(executors: ExecutorConfig[], nowSec: number, onProgress: (text: string) => void): Promise<AttributionReadings> {
  const own = executors.filter((executor) => executor.mode === 'paper' && executor.type === 'position' && executor.watch !== undefined && executor.watch.result !== undefined)
  const sinceSec = nowSec - DAYS * 86_400
  onProgress('Reading the events and the calls…')
  const [eventsPage, callsPage, newsPage, feed] = await Promise.all([
    window.api.scanner.listEvents({ sinceSec: sinceSec - 3600, limit: ROWS_READ }),
    window.api.ai.listCalls({ source: 'watch', sinceSec: sinceSec - 3600, limit: ROWS_READ }),
    window.api.ai.listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, sinceSec: sinceSec - 3600, limit: ROWS_READ }),
    window.api.feed.getState()
  ])
  const events: Record<string, MarketEvent> = {}
  for (const event of eventsPage.rows) events[event.id] = event
  const eventIds = new Set(own.map((executor) => executor.watch?.eventId).filter((id): id is string => typeof id === 'string'))
  const tradedEvents = [...eventIds].map((id) => events[id]).filter((event): event is MarketEvent => event !== undefined)

  // The vote on each event: of the models that answered usably, how many took the trade's side.
  const answers = new Map<string, Map<string, AiCallRecord>>()
  for (const row of [...callsPage.rows].sort((a, b) => a.at - b.at)) {
    if (row.eventId === undefined || row.status !== 'ok') continue
    const byModel = answers.get(row.eventId) ?? new Map<string, AiCallRecord>()
    if (!byModel.has(row.model)) byModel.set(row.model, row)
    answers.set(row.eventId, byModel)
  }
  const votes: Record<string, { taking: number; usable: number }> = {}
  const signals: Record<string, number | null> = {}
  const readings = newsReadingsOf(newsPage.rows)
  for (const executor of own) {
    const mark = executor.watch as NonNullable<ExecutorConfig['watch']>
    const byModel = answers.get(mark.eventId)
    const params = executor.params as PositionExecutorParams
    if (byModel !== undefined) {
      const rows = [...byModel.values()]
      const usable = rows.filter((row) => row.recommendation !== null).length
      const taking = rows.filter((row) => (row.recommendation === 'buy' && params.side === 'buy') || (row.recommendation === 'sell' && params.side === 'sell')).length
      votes[mark.eventId] = { taking, usable }
    }
    // The signal at the call, read back from the same records the table scores by: the event, the
    // answers in by then, the stories the feed still holds, and the regime the trade recorded.
    const event = events[mark.eventId]
    if (event !== undefined && byModel !== undefined) {
      const calls: SignalCall[] = [...byModel.values()]
        .filter((row) => row.at <= executor.createdAt)
        .map((row) => {
          const decision = { recommendation: row.recommendation, confidence: row.confidence ?? 0, detail: row.detail, rejected: false, error: null } as unknown as Parameters<typeof opportunitySide>[0]
          return { side: opportunitySide(decision), refused: false, acted: isActionableOpportunity(decision) }
        })
      const side = scoredSide(params.side === 'buy' ? 'long' : 'short', event.direction)
      signals[executor.id] = signalScore({ event, side, calls, stories: feed.stories, reactions: feed.reactions, readings, regime: mark.regime ?? null, nowSec: executor.createdAt }).score
    }
  }

  onProgress("Reading Bitcoin's direction at each event…")
  const fetchCandles = async (exchange: MarketEvent['exchange'], symbol: string, interval: '1m' | '15m', startSec: number, endSec: number): Promise<Candle[]> =>
    (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles
  const labels = await loadLiveLabels(tradedEvents, fetchCandles)
  const btc: Record<string, 'rising' | 'falling' | 'flat'> = {}
  for (const [id, label] of Object.entries(labels)) btc[id] = label.btcRegime

  onProgress('Reading the stories around each event…')
  let news: Record<string, boolean | null> = {}
  try {
    const marks = await window.api.feed.history(sinceSec - 4 * 3600, nowSec)
    const byEvent = eventNewsOf(tradedEvents, marks)
    for (const executor of own) {
      const mark = executor.watch as NonNullable<ExecutorConfig['watch']>
      const read = byEvent[mark.eventId]
      const params = executor.params as PositionExecutorParams
      if (read === undefined || read === null) continue
      const way = params.side === 'buy' ? read.up : read.down
      news[mark.eventId] = way ? true : !read.any ? false : null
    }
  } catch {
    news = {}
  }

  // What holding the window would have made: from the entry to the plan's end, at the stake, after fees.
  const holds: Record<string, number | null> = {}
  let done = 0
  for (const executor of own) {
    onProgress(`Reading each trade's window: ${++done} of ${own.length}`)
    const params = executor.params as PositionExecutorParams
    const result = (executor.watch as NonNullable<ExecutorConfig['watch']>).result
    // A trade with no plan's end has no window to hold: the watch's trades all have one.
    if (result === undefined || result.exit === 'entry_expired' || result.exit === 'btc_moved' || params.timeLimitSec === null) continue
    try {
      const endSec = Math.min(nowSec, result.closedAt + params.timeLimitSec + AFTER_END_SEC)
      const minutes = await fetchCandles(executor.exchange, executor.symbol, '1m', executor.createdAt, endSec)
      const read = readTrade(executor, minutes, nowSec)
      if (read.entryPrice === null || read.enteredAt === null) continue
      const plannedEnd = read.enteredAt + params.timeLimitSec
      const last = minutes.filter((bar) => bar.time <= plannedEnd && bar.time + 60 <= nowSec).at(-1)
      if (last === undefined) continue
      const quantity = (params.amountQuote * (params.leverage ?? 1)) / read.entryPrice
      const gross = quantity * (last.close - read.entryPrice) * (params.side === 'buy' ? 1 : -1)
      holds[executor.id] = gross - roundTripFee(quantity, read.entryPrice, last.close)
    } catch {
      holds[executor.id] = null
    }
  }
  return { events, votes, btc, signals, holds, news }
}

function SliceTable({ title, rows, keyLabel = (key: string): string => key }: { title: string; rows: SliceRow[]; keyLabel?: (key: string) => string }): React.JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <div style={{ overflowX: 'auto' }}>
      <p style={{ margin: '0.6rem 0 0.3rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['', 'Trades', 'Won', 'Win rate', 'A trade', 'R a trade', 'Net'].map((column, index) => (
              <th key={index} style={headCellStyle}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td style={cellStyle}>{keyLabel(row.key)}</td>
              <td style={cellStyle}>{row.trades}</td>
              <td style={cellStyle}>{row.wins}</td>
              <td style={{ ...cellStyle, color: row.enough ? 'var(--text-primary)' : 'var(--text-muted)' }}>{row.winRatePct === null ? `under ${RESEARCH_MIN_SLICE}` : `${row.winRatePct.toFixed(0)}%`}</td>
              <td style={cellStyle}>{pct(row.expectancyPct)}</td>
              <td style={cellStyle}>{row.meanR === null ? '—' : `${row.meanR >= 0 ? '+' : ''}${row.meanR.toFixed(2)} R`}</td>
              <td style={{ ...cellStyle, color: row.netQuote >= 0 ? 'var(--up)' : 'var(--down)' }}>{money(row.netQuote)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SourceTable({ title, rows, keyLabel = (key: string): string => key }: { title: string; rows: NetSourceRow[]; keyLabel?: (key: string) => string }): React.JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <div style={{ overflowX: 'auto' }}>
      <p style={{ margin: '0.6rem 0 0.3rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['', 'Trades', 'Net', "The pair's move over the window", 'The rest: the exit'].map((column, index) => (
              <th key={index} style={headCellStyle}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td style={cellStyle}>{keyLabel(row.key)}</td>
              <td style={{ ...cellStyle, color: row.enough ? 'var(--text-primary)' : 'var(--text-muted)' }}>{row.trades}</td>
              <td style={cellStyle}>{money(row.netQuote)}</td>
              <td style={cellStyle}>{money(row.holdNetQuote)}</td>
              <td style={{ ...cellStyle, color: row.restQuote >= 0 ? 'var(--up)' : 'var(--down)' }}>{money(row.restQuote)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const VOTE_WORDS: Record<string, string> = { all: 'All agreed', majority: 'More than half agreed', half_or_fewer: 'Half or fewer agreed', 'one model': 'One model asked' }

/** Where the result came from (shared/performance/attribution.ts; the V5 document, §82-90): over
 * the watch's closed paper trades of the last ninety days, how much of the net a few trades made,
 * what the signal at the call said of them, the result by pair, cap tier, regime, model, kind,
 * news and vote, and the pair's own move over each window against the rest. Read from the
 * records; nothing here asks, stores or acts. */
export function AttributionCard({ executors }: { executors: ExecutorConfig[] | null }): React.JSX.Element {
  const [readings, setReadings] = useState<AttributionReadings | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const closed = useMemo(() => (executors ?? []).filter((executor) => executor.mode === 'paper' && executor.type === 'position' && (executor.watch?.result !== undefined || executor.newsRule?.result !== undefined)).length, [executors])

  async function read(): Promise<void> {
    if (executors === null || progress !== null) return
    setProblem(null)
    setProgress('Reading…')
    try {
      setReadings(await readReadings(executors, Math.floor(Date.now() / 1000), setProgress))
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setProgress(null)
    }
  }
  useEffect(() => {
    setReadings(null)
  }, [executors])

  const report: Attribution | null = useMemo(() => (executors === null || readings === null ? null : attribution(attributedTrades(executors, readings))), [executors, readings])

  const save = async (): Promise<void> => {
    if (report === null) return
    try {
      const outcome = await window.api.backtest.exportSave({ defaultFileName: `attribution-${new Date().toISOString().slice(0, 10)}.csv`, content: attributionCsv(report), format: 'csv' })
      setNote(outcome.status === 'saved' ? `Saved to ${outcome.filePath}` : 'Not saved.')
    } catch (failure) {
      setNote(`Could not save: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
  }

  return (
    <Card title="Where the result came from">
      <p style={{ ...noteStyle, marginTop: 0 }}>
        Over the app&apos;s own paper trades that have closed in the last {DAYS} days: how much of the net a few trades made, what the signal at the call said of the trades that
        followed, the result by pair, by how much the pair trades, by the market&apos;s regime at entry, by model, kind, news and vote, and the pair&apos;s own move over each
        trade&apos;s window against the rest, which is the exit. {RESEARCH_MIN_TRADES} closed trades for a figure, {RESEARCH_MIN_SLICE} for a slice, as the Research tab counts. Read from the
        records; nothing here is stored or acted on.
      </p>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => void read()} disabled={executors === null || progress !== null || closed === 0} style={buttonStyle('primary', executors === null || progress !== null || closed === 0)}>
          {progress ?? (readings === null ? `Read the ${closed} closed trades` : 'Read again')}
        </button>
        {report !== null && (
          <button onClick={() => void save()} style={buttonStyle('secondary')}>
            Save as CSV
          </button>
        )}
        {note !== null && <span style={noteStyle}>{note}</span>}
        {problem !== null && <span style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</span>}
      </div>
      {closed === 0 && <p style={noteStyle}>No paper trade of the app&apos;s own has closed yet.</p>}
      {report !== null && (
        <div data-testid="attribution">
          <p style={{ margin: '0.7rem 0 0.2rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Concentration.</strong> {report.concentration.trades} closed trades, net {money(report.concentration.netQuote)}.{' '}
            {report.concentration.enough
              ? report.concentration.top5Pct === null
                ? 'The net is not positive, so no share is said.'
                : `The best 1% of trades made ${report.concentration.top1Pct?.toFixed(0)}% of it, the best 5% ${report.concentration.top5Pct.toFixed(0)}%, the best 10% ${report.concentration.top10Pct?.toFixed(0)}%; the best five ${report.concentration.bestFiveSharePct?.toFixed(0)}%${report.concentration.fragile ? ': fragile, five trades are the result' : ''}.`
              : `Under ${RESEARCH_MIN_TRADES}: no share is said yet.`}
          </p>
          <SliceTable title="By the signal at the call" rows={report.scores} />
          <SliceTable title="By pair" rows={report.byPair} />
          <SliceTable title="By how much the pair trades a day" rows={report.byCapTier} keyLabel={(key) => ({ large: 'Large: $100M or more', mid: 'Mid: $20M to $100M', small: 'Small: under $20M' })[key] ?? key} />
          <SliceTable title="By the market's regime at entry (Bitcoin's direction where the trade recorded none)" rows={report.byRegime} />
          <SliceTable title="By model" rows={report.byModel} keyLabel={describeDecider} />
          <SliceTable title="By kind of event" rows={report.byKind} />
          <SliceTable title="By news: a fresh story pointing the trade's way, or none naming the coin" rows={report.byNews} />
          <SliceTable title="By the vote" rows={report.byVote} keyLabel={(key) => VOTE_WORDS[key] ?? key} />
          <SourceTable title="Where the net came from" rows={report.sources.all} keyLabel={() => 'All trades'} />
          <SourceTable title="By kind of event" rows={report.sources.byKind} />
          <SourceTable title="By news" rows={report.sources.byNews} />
          <SourceTable title="By model" rows={report.sources.byModel} keyLabel={describeDecider} />
          <SourceTable title="By the vote" rows={report.sources.byVote} keyLabel={(key) => VOTE_WORDS[key] ?? key} />
          <p style={noteStyle}>
            The pair&apos;s move over the window is what holding it from the entry to the plan&apos;s end at the stake would have made, after fees; the rest is what the exit -- the target, the
            stop, the clock or the exit check -- added or cost. The signal is read back from the same records the table scores by, with the stories the feed still holds; a trade older than
            those reads as not scored. Figures: {ratio(null)} where under the minimum.
          </p>
        </div>
      )}
    </Card>
  )
}
