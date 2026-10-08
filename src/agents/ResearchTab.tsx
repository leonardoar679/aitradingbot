import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { EVENT_RULE_MAJORITY, EVENT_RULE_UNANIMOUS, EVENT_RULE_WEIGHTED, summarizeEventBenchmark, type EventBenchmarkRow } from '../../shared/aiEventBenchmark'
import { isActionableOpportunity, opportunitySide } from '../../shared/aiOpportunity'
import type { Candle, ExecutorConfig } from '../../shared/ipc'
import type { MarketEvent } from '../../shared/marketEvent'
import { scanHistoryRequests } from '../../shared/marketScanner'
import { expectedDirection, type StoryReaction } from '../../shared/newsFeed'
import { scoredSide, signalScore, type SignalScore } from '../../shared/opportunityScore'
import { CAPTURE_DAYS, CAPTURE_MOVE_PCT, captureSummary, missedMoves, truthMoves, type CaptureSummary, type MissedMove } from '../../shared/research/captureRate'
import { RESEARCH_MAX_EVENTS, RESEARCH_MIN_SLICE, RESEARCH_MIN_TRADES, csvOf, figure, type ResearchInput, type TradeStats } from '../../shared/research/common'
import { entryTimingRows } from '../../shared/research/entryTiming'
import { excursionAnswers, excursionTrades } from '../../shared/research/excursions'
import { exitCheckRow, exitRuleRows } from '../../shared/research/exitRules'
import { falseOpportunityRows } from '../../shared/research/falseOpportunities'
import { HOLDS, holdingRows } from '../../shared/research/holdingByType'
import { NEWS_DELAYS, newsTimingRows } from '../../shared/research/newsTiming'
import { ablationRows } from '../../shared/research/scoreAblation'
import { agreementValue } from '../../shared/research/agreementValue'
import type { AiCallRecord } from '../../shared/aiLedger'
import { useNewsFeed } from '../news/useNewsFeed'
import { describeError } from '../utils/ipcError'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from './agentStyles'
import { loadLiveBars, readLiveAnswers, type LiveBoardDeps } from './liveBoard'

// RESEARCH ON THE RECORD (the V4 document, §57-72): the tables shared/research/ builds, over the
// watch's answers on file and the candles their outcomes fetch. IT READS: the ledger, the events,
// the executors, the feed and public candles; it asks no model and acts on nothing. The candles
// are read on a click, since they are a request an event; so is a history scan.

const LEAD_SECONDS = 4 * 3600
const NEWS_STORIES_READ = 60
const NEWS_BARS_SECONDS = 4000
const MISS_BARS_SECONDS = 3700
const FETCH_AT_ONCE = 4

const deps: LiveBoardDeps = {
  listCalls: (filter) => window.api.ai.listCalls(filter),
  listEvents: (filter) => window.api.scanner.listEvents(filter),
  fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles
}

async function inBatches<T>(items: T[], each: (item: T) => Promise<void>, onDone: (done: number) => void): Promise<void> {
  let done = 0
  for (let index = 0; index < items.length; index += FETCH_AT_ONCE) {
    await Promise.all(items.slice(index, index + FETCH_AT_ONCE).map((item) => each(item).then(() => onDone(++done))))
  }
}

interface Loaded {
  input: ResearchInput
  lead: Record<string, Candle[]>
  scores: Record<string, SignalScore>
  rules: EventBenchmarkRow[]
}

const STAT_HEADERS = ['Trades', 'Closed', 'Win rate', 'Profit factor', 'Expectancy', 'Mean R', 'MFE', 'MAE']
const statCells = (stats: TradeStats): (string | number)[] => [stats.trades, stats.closed, figure(stats.winRatePct), figure(stats.profitFactor, 'ratio'), figure(stats.expectancyPct), figure(stats.meanR, 'r'), figure(stats.meanBestPct), figure(stats.meanWorstPct)]

function Table({ headers, rows, onExport }: { headers: string[]; rows: (string | number)[][]; onExport: () => void }): React.JSX.Element {
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header} style={headCellStyle}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} style={{ borderBottom: '1px solid var(--border)' }}>
                {row.map((cell, column) => (
                  <td key={column} style={{ ...cellStyle, color: cell === 'not enough' ? 'var(--text-muted)' : undefined }}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={onExport} style={{ ...buttonStyle('secondary'), marginTop: '0.5rem' }}>
        Export CSV
      </button>
    </>
  )
}

export function ResearchTab(): React.JSX.Element {
  const feed = useNewsFeed()
  const [models, setModels] = useState<string[] | null>(null)
  const [executors, keepExecutors] = useState<ExecutorConfig[]>([])
  const [watchRows, keepWatchRows] = useState<AiCallRecord[]>([])
  const [answered, setAnswered] = useState<{ events: MarketEvent[]; models: string[] } | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [newsBars, setNewsBars] = useState<Record<string, Candle[]> | null>(null)
  const [capture, setCapture] = useState<{ summary: CaptureSummary; misses: MissedMove[]; scanned: number } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const stop = useRef(false)
  const live = useRef<Awaited<ReturnType<typeof readLiveAnswers>> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const nowSec = Math.floor(Date.now() / 1000)
        const [config, settings, ledger] = await Promise.all([
          window.api.ai.getConfig(),
          window.api.settings.get(),
          // The watch's own answers over ninety days, for how many models agreed on each trade's event.
          window.api.ai.listCalls({ source: 'watch', sinceSec: nowSec - 90 * 86_400, limit: 5000 }).then(
            (page) => page.rows,
            () => [] as AiCallRecord[]
          )
        ])
        if (cancelled) return
        setModels(config.enabledModels)
        keepExecutors(settings.executors)
        keepWatchRows(ledger)
        const read = await readLiveAnswers(config.enabledModels, nowSec, deps)
        if (cancelled) return
        live.current = read
        setAnswered({ events: read.events, models: config.enabledModels })
      } catch (failure) {
        if (!cancelled) setProblem(describeError(failure))
      }
    })()
    return (): void => {
      cancelled = true
      stop.current = true
    }
  }, [])

  const read = useCallback(async (): Promise<void> => {
    const answers = live.current
    if (answers === null || models === null) return
    stop.current = false
    setProblem(null)
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      // The newest events, at most RESEARCH_MAX_EVENTS: the answers are kept in step with them.
      const keep = answers.events.length > RESEARCH_MAX_EVENTS ? answers.events.length - RESEARCH_MAX_EVENTS : 0
      const events = answers.events.slice(keep)
      const sliced = (byModel: Record<string, (unknown | null)[]>): Record<string, never[]> => Object.fromEntries(Object.entries(byModel).map(([model, list]) => [model, list.slice(keep) as never[]]))
      const input: ResearchInput = { events, models, answers: sliced(answers.answers), answeredAt: sliced(answers.answeredAt), nowSec, bars: {} }
      setProgress(`Reading the candles after ${events.length} events…`)
      input.bars = await loadLiveBars(events, nowSec, deps.fetchCandles, { shouldStop: () => stop.current, onProgress: (done, total) => setProgress(`Reading the candles after each event: ${done} of ${total}…`) })
      if (stop.current) return
      const lead: Record<string, Candle[]> = {}
      await inBatches(
        events,
        async (event) => {
          try {
            lead[event.id] = await deps.fetchCandles(event.exchange, event.symbol, '1m', event.time - LEAD_SECONDS, event.time)
          } catch {
            lead[event.id] = []
          }
        },
        (done) => setProgress(`Reading the four hours before each event, for the ATR: ${done} of ${events.length}…`)
      )
      if (stop.current) return
      // Each event's signal score as it is scored now, from what is on file: the news as read today,
      // and no regime, which is not kept from the time.
      const scores: Record<string, SignalScore> = {}
      for (const [index, event] of events.entries()) {
        const calls = models.map((model) => input.answers[model]?.[index] ?? null).filter((decision) => decision !== null).map((decision) => ({ side: opportunitySide(decision), refused: Boolean(decision.rejected), acted: isActionableOpportunity(decision) }))
        scores[event.id] = signalScore({ event, side: scoredSide(null, event.direction), calls, stories: feed?.stories ?? [], reactions: feed?.reactions ?? {}, regime: null, nowSec })
      }
      const rules = summarizeEventBenchmark({ ...input, answeredAt: input.answeredAt }).models.filter((row) => [EVENT_RULE_MAJORITY, EVENT_RULE_UNANIMOUS, EVENT_RULE_WEIGHTED].includes(row.name))
      setLoaded({ input, lead, scores, rules })
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setProgress(null)
    }
  }, [models, feed])

  const readNews = useCallback(async (): Promise<void> => {
    if (feed === null) return
    const reactions = Object.values(feed.reactions)
      .filter((reaction) => expectedDirection(reaction.eventType) !== null && reaction.after.h1 !== null)
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, NEWS_STORIES_READ)
    const bars: Record<string, Candle[]> = {}
    stop.current = false
    try {
      await inBatches(
        reactions,
        async (reaction: StoryReaction) => {
          try {
            bars[reaction.storyId] = await deps.fetchCandles('binance', reaction.symbol, '1m', reaction.publishedAt - 120, reaction.publishedAt + NEWS_BARS_SECONDS)
          } catch {
            bars[reaction.storyId] = []
          }
        },
        (done) => setProgress(`Reading the minutes around each story: ${done} of ${reactions.length}…`)
      )
      setNewsBars(bars)
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setProgress(null)
    }
  }, [feed])

  const scan = useCallback(async (): Promise<void> => {
    if (loaded === null || live.current === null) return
    stop.current = false
    setProblem(null)
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const state = await window.api.scanner.getState()
      const pairs = state.pairs.map((pair) => ({ symbol: pair.symbol, baseAsset: pair.baseAsset, quoteAsset: pair.quoteAsset }))
      if (pairs.length === 0) {
        setProblem('The scanner has read no pairs yet, so there is no universe to scan. Switch it on under Settings › Market.')
        return
      }
      const startSec = nowSec - CAPTURE_DAYS * 86_400
      const requestId = crypto.randomUUID()
      setProgress(`Scanning ${pairs.length} pairs over the last ${CAPTURE_DAYS} days…`)
      const unsubscribe = window.api.scanner.onHistoryProgress((step) => {
        if (step.requestId === requestId) setProgress(`Scanning ${step.symbol}: pair ${step.pairsDone} of ${step.pairsTotal}…`)
      })
      let result
      try {
        result = await window.api.scanner.scanHistory({ requestId, pairs, startSec, endSec: nowSec, floor: 'candidate' })
      } finally {
        unsubscribe()
      }
      const raised = (await deps.listEvents({ sinceSec: startSec - 3600, limit: 5000 })).rows
      const askedIds = new Set(live.current.events.map((event) => event.id))
      const moves = truthMoves(result.events, raised, askedIds)
      const summary = captureSummary(moves, loaded.input)
      const toFollow = moves.filter((move) => !move.asked).slice(0, 50)
      const bars: Record<string, Candle[]> = {}
      await inBatches(
        toFollow,
        async (move) => {
          try {
            bars[`${move.symbol}:${move.time}`] = await deps.fetchCandles('binance', move.symbol, '1m', move.time, Math.min(nowSec, move.time + MISS_BARS_SECONDS))
          } catch {
            bars[`${move.symbol}:${move.time}`] = []
          }
        },
        (done) => setProgress(`Following the missed moves for an hour: ${done} of ${toFollow.length}…`)
      )
      setCapture({ summary, misses: missedMoves(moves, bars, nowSec), scanned: result.events.length })
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setProgress(null)
    }
  }, [loaded])

  async function exportCsv(name: string, csv: string): Promise<void> {
    setNote(null)
    try {
      const outcome = await window.api.backtest.exportSave({ defaultFileName: `research-${name}-${new Date().toISOString().slice(0, 10)}.csv`, content: csv, format: 'csv' })
      if (outcome.status === 'saved') setNote(`Saved to ${outcome.filePath}`)
      else if (outcome.status === 'error') setNote(`Could not save the file: ${outcome.message}`)
    } catch (failure) {
      setNote(describeError(failure))
    }
  }

  const exits = useMemo(() => (loaded === null ? null : exitRuleRows(loaded.input, loaded.lead)), [loaded])
  const checkRow = useMemo(() => exitCheckRow(executors), [executors])
  const agreement = useMemo(() => agreementValue(executors, watchRows), [executors, watchRows])
  const timings = useMemo(() => (loaded === null ? null : entryTimingRows(loaded.input)), [loaded])
  const holds = useMemo(() => (loaded === null ? null : holdingRows(loaded.input)), [loaded])
  const falses = useMemo(() => (loaded === null ? null : falseOpportunityRows(loaded.input)), [loaded])
  const ablation = useMemo(() => (loaded === null ? null : ablationRows(loaded.input, loaded.scores)), [loaded])
  const excursions = useMemo(() => excursionAnswers(excursionTrades(executors)), [executors])
  const news = useMemo(() => (feed === null || newsBars === null ? null : newsTimingRows(Object.values(feed.reactions), newsBars, Math.floor(Date.now() / 1000))), [feed, newsBars])

  const scanRequests = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000)
    return scanHistoryRequests(60, nowSec - CAPTURE_DAYS * 86_400, nowSec, 240)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <Card title="Research on the record">
        <p style={{ ...noteStyle, marginTop: 0 }}>
          What the records already hold, read as tables, with no model asked and nothing acted on: the watch&apos;s answers over the last thirty days, the
          candles their outcomes are scored on, the app&apos;s own paper trades, and the feed. GROSS is before the fees and slippage the score charges, NET
          after them, LIVE PAPER the app&apos;s own paper trades as they were settled. A row needs {RESEARCH_MIN_TRADES} trades and a slice {RESEARCH_MIN_SLICE},
          or it says &quot;not enough&quot;. The candles are read on a click: one request an event, and one more for the four hours before it.
        </p>
        {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
        {answered === null && problem === null && <p style={noteStyle}>Reading the answers on file…</p>}
        {answered !== null && (
          <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={noteStyle}>
              {answered.events.length} events the watch asked {answered.models.length} {answered.models.length === 1 ? 'model' : 'models'} about in the last thirty days
              {answered.events.length > RESEARCH_MAX_EVENTS ? `; the newest ${RESEARCH_MAX_EVENTS} are read` : ''}.
            </span>
            <button onClick={() => void read()} disabled={progress !== null || answered.events.length === 0} style={buttonStyle('primary', progress !== null)}>
              {loaded === null ? 'Read the candles and build the tables' : 'Read again'}
            </button>
            {progress !== null && (
              <>
                <span style={noteStyle}>{progress}</span>
                <button onClick={() => (stop.current = true)} style={buttonStyle('secondary')}>
                  Stop
                </button>
              </>
            )}
          </div>
        )}
        {note !== null && <p style={{ ...noteStyle, marginTop: '0.5rem' }}>{note}</p>}
      </Card>

      {exits !== null && (
        <Card title="Exit rules on identical entries">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            The same calls, the same entries, four ways out, each scored on the same minutes. NET. The exit check&apos;s own trades are set beside them as they
            were settled, LIVE PAPER: {checkRow.closedByCheck} closed by the check of {checkRow.closed} closed, at a mean of {figure(checkRow.meanPctByCheck)} of the stake
            each against {figure(checkRow.meanPctOthers)} for the trades it left alone.
          </p>
          <Table
            headers={['Rule', 'Label', ...STAT_HEADERS, 'Not measured']}
            rows={exits.map((row) => [row.name, row.label, ...statCells(row.stats), row.unmeasured])}
            onExport={() => void exportCsv('exit-rules', csvOf(['Rule', 'Label', ...STAT_HEADERS, 'Not measured'], exits.map((row) => [row.name, row.label, ...statCells(row.stats), row.unmeasured])))}
          />
        </Card>
      )}

      {timings !== null && (
        <Card title="Entry timing">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            The same calls entered at the answer, one, three and five minutes after it, and after one bar closes the call&apos;s way, with the same bracket. An entry
            that waits can miss its range. &quot;Holds above the breakout zone&quot; is measured here, as the confirming bar. NET.
          </p>
          <Table
            headers={['Entry', 'Label', ...STAT_HEADERS, 'Expired', 'No confirming bar']}
            rows={timings.map((row) => [row.name, row.label, ...statCells(row.stats), row.expired, row.unconfirmed])}
            onExport={() => void exportCsv('entry-timing', csvOf(['Entry', 'Label', ...STAT_HEADERS, 'Expired', 'No confirming bar'], timings.map((row) => [row.name, row.label, ...statCells(row.stats), row.expired, row.unconfirmed])))}
          />
        </Card>
      )}

      {holds !== null && (
        <Card title="Holding time by event type">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            Each event followed its own way from the first minute after the question could have been put, with no stop and no target, and out after each
            hold: the mean net a trade. NET; {RESEARCH_MIN_SLICE} events a slice.
          </p>
          <Table
            headers={['Kind', 'Events', ...HOLDS.map((hold) => hold.name)]}
            rows={holds.map((row) => [row.name, row.events, ...HOLDS.map((hold) => figure(row.byHold[hold.id].expectancyPct))])}
            onExport={() => void exportCsv('holding-time', csvOf(['Kind', 'Events', ...HOLDS.map((hold) => hold.name)], holds.map((row) => [row.name, row.events, ...HOLDS.map((hold) => figure(row.byHold[hold.id].expectancyPct))])))}
          />
        </Card>
      )}

      {feed !== null && (
        <Card title="News timing">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            A story of a kind with a way of its own, followed that way from the minute after it was published, or one, three or five minutes later, and out
            an hour after the entry: the mean net a story, by kind. On minute bars: there is no thirty-second step to measure. NET; {RESEARCH_MIN_SLICE} stories
            a slice. The minutes around the last {NEWS_STORIES_READ} stories with a reaction are read on a click, one request each.
          </p>
          {news === null ? (
            <button onClick={() => void readNews()} disabled={progress !== null} style={buttonStyle('secondary', progress !== null)}>
              Read the minutes around the stories
            </button>
          ) : news.length === 0 ? (
            <p style={noteStyle}>No story of a kind with a way of its own has a reaction on file yet.</p>
          ) : (
            <Table
              headers={['Kind', 'Way', 'Stories', ...NEWS_DELAYS.map((delay) => `+${delay} min`)]}
              rows={news.map((row) => [row.name, row.direction, row.stories, ...NEWS_DELAYS.map((delay) => figure(row.byDelay[delay].expectancyPct))])}
              onExport={() => void exportCsv('news-timing', csvOf(['Kind', 'Way', 'Stories', ...NEWS_DELAYS.map((delay) => `+${delay} min`)], news.map((row) => [row.name, row.direction, row.stories, ...NEWS_DELAYS.map((delay) => figure(row.byDelay[delay].expectancyPct))])))}
            />
          )}
        </Card>
      )}

      {loaded !== null && (
        <Card title="Consensus">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            The rules that trade only when the models agree, on the watch&apos;s own answers, as the live board scores them. NET.
            {loaded.input.models.length < 2 ? ' The watch asks one model, so there is nothing for them to agree on until it asks more.' : ''}
          </p>
          <Table
            headers={['Rule', 'Compared', 'Closed', 'Win rate', 'Profit factor', 'Mean net']}
            rows={loaded.rules.map((row) => [row.name, row.actionable, row.closed, figure(row.winRatePct), figure(row.profitFactor, 'ratio'), figure(row.meanNetPct)])}
            onExport={() => void exportCsv('consensus', csvOf(['Rule', 'Compared', 'Closed', 'Win rate', 'Profit factor', 'Mean net'], loaded.rules.map((row) => [row.name, row.actionable, row.closed, figure(row.winRatePct), figure(row.profitFactor, 'ratio'), figure(row.meanNetPct)])))}
          />
        </Card>
      )}

      <Card title="Agreement value">
        <p style={{ ...noteStyle, marginTop: 0 }} data-testid="agreement-note">
          The watch&apos;s own closed paper trades by how many of the models asked took their side (the V5 document, §90). LIVE PAPER, as settled; thirty
          trades a row.
          {agreement.modelsAsked < 2 ? ' The watch asks one model, so there is nothing for models to agree on until it asks more.' : ''}
        </p>
        <Table
          headers={['Agreed', 'Closed', 'Wins', 'Win rate', 'Profit factor', 'Mean net']}
          rows={agreement.rows.map((row) => [row.name, row.closed, row.wins, figure(row.winRatePct), figure(row.profitFactor, 'ratio'), figure(row.meanNetPct)])}
          onExport={() =>
            void exportCsv(
              'agreement',
              csvOf(['Agreed', 'Closed', 'Wins', 'Win rate', 'Profit factor', 'Mean net'], agreement.rows.map((row) => [row.name, row.closed, row.wins, figure(row.winRatePct), figure(row.profitFactor, 'ratio'), figure(row.meanNetPct)]))
            )
          }
        />
      </Card>

      {ablation !== null && (
        <Card title="What each input of the signal score earns">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            The score with one input left out and the rest re-weighed, and what each day&apos;s three strongest events under it would have made followed their own
            way for an hour. Scored from what is on file now: the news as read today, and no regime, which is not kept from the time. NET; {RESEARCH_MIN_TRADES} picks a row.
          </p>
          <Table
            headers={['Score', 'Days', 'Picks', ...STAT_HEADERS]}
            rows={ablation.map((row) => [row.name, row.days, row.picks, ...statCells(row.stats)])}
            onExport={() => void exportCsv('ablation', csvOf(['Score', 'Days', 'Picks', ...STAT_HEADERS], ablation.map((row) => [row.name, row.days, row.picks, ...statCells(row.stats)])))}
          />
        </Card>
      )}

      {loaded !== null && (
        <Card title="Capture and misses">
          <p style={{ ...noteStyle, marginTop: 0 }}>
            A ground truth outside the detector&apos;s bands: every move of {CAPTURE_MOVE_PCT}% or more in fifteen minutes over the last {CAPTURE_DAYS} days, found by a
            history scan of the scanner&apos;s pairs at its lowest floor, against what the live scanner raised and the watch asked about. Recall is the share raised;
            decision precision the share of the watch&apos;s actionable answers that won by their own bracket (NET). A scan is free and about {scanRequests} requests for
            sixty pairs.
          </p>
          {capture === null ? (
            <button onClick={() => void scan()} disabled={progress !== null} style={buttonStyle('secondary', progress !== null)}>
              Scan the last {CAPTURE_DAYS} days
            </button>
          ) : (
            <>
              <p style={noteStyle}>
                {capture.scanned} events found by the scan, {capture.summary.moves} of them moves of {CAPTURE_MOVE_PCT}% or more in fifteen minutes; {capture.summary.raised} raised live (recall{' '}
                {capture.summary.recallPct === null ? '—' : `${capture.summary.recallPct.toFixed(0)}%`}), {capture.summary.asked} asked about. Decision precision{' '}
                {capture.summary.decisionPrecisionPct === null ? `not enough (${capture.summary.closedAnswers} closed answers)` : `${capture.summary.decisionPrecisionPct.toFixed(0)}% of ${capture.summary.closedAnswers} closed answers`}.
              </p>
              <Table
                headers={['Pair', 'When (UTC)', '15 min move', 'Why missed', 'Followed an hour (NET)']}
                rows={capture.misses.map((miss) => [miss.symbol, new Date(miss.time * 1000).toISOString().slice(0, 16).replace('T', ' '), figure(miss.m15Pct), miss.why, figure(miss.followedNetPct)])}
                onExport={() => void exportCsv('misses', csvOf(['Pair', 'When (UTC)', '15 min move', 'Why missed', 'Followed an hour (NET)'], capture.misses.map((miss) => [miss.symbol, new Date(miss.time * 1000).toISOString(), miss.m15Pct, miss.why, miss.followedNetPct])))}
              />
            </>
          )}
        </Card>
      )}

      {falses !== null && (
        <Card title="False opportunities">
          <p style={{ ...noteStyle, marginTop: 0 }}>Of the answers this app would act on, by the kind of event, how many lost by their own bracket. NET; {RESEARCH_MIN_SLICE} a kind.</p>
          <Table
            headers={['Kind', 'Calls', 'Closed', 'Losses', 'Loss share', 'Expectancy']}
            rows={falses.map((row) => [row.name, row.calls, row.closed, row.losses, figure(row.lossSharePct), figure(row.stats.expectancyPct)])}
            onExport={() => void exportCsv('false-opportunities', csvOf(['Kind', 'Calls', 'Closed', 'Losses', 'Loss share', 'Expectancy'], falses.map((row) => [row.name, row.calls, row.closed, row.losses, figure(row.lossSharePct), figure(row.stats.expectancyPct)])))}
          />
        </Card>
      )}

      <Card title="Excursions on file">
        <p style={{ ...noteStyle, marginTop: 0 }}>
          From the watch&apos;s paper trades that carry how far the price went for them and against them while they were held (written when a trade closes, since
          8 October 2026). LIVE PAPER; {RESEARCH_MIN_TRADES} trades. {excursions.trades} on file, {excursions.winners} of them winners.
        </p>
        <ul style={{ ...noteStyle, paddingLeft: '1.2rem', margin: 0 }}>
          <li>How often a winner first fell 1% against it: {excursions.winnersFellFirstPct === null ? 'not enough' : `${excursions.winnersFellFirstPct.toFixed(0)}% of winners`}.</li>
          <li>How far winners ran in their favour: {excursions.medianWinnerBestPct === null ? 'not enough' : `a median of ${figure(excursions.medianWinnerBestPct)}`}.</li>
          <li>
            What a stop half as far would have cost:{' '}
            {excursions.halfStopWouldCut === null ? 'not enough' : `${excursions.halfStopWouldCut.share.toFixed(0)}% of winners would have been stopped out, ${figure(excursions.halfStopWouldCut.netPctLost)} of a stake together`}.
          </li>
          <li>How often the target cut a bigger winner short: {excursions.targetCutBiggerPct === null ? 'not enough' : `${excursions.targetCutBiggerPct.toFixed(0)}% of trades that reached it went on at least a target further`}.</li>
        </ul>
      </Card>
    </div>
  )
}
