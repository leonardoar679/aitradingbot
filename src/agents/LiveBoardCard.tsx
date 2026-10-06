import { useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { summarizeEventBenchmark } from '../../shared/aiEventBenchmark'
import { AI_HELP_NEWS_SECONDS, eventNewsOf } from '../../shared/aiHelp'
import { describeDecider } from '../../shared/aiPanel'
import type { Candle } from '../../shared/ipc'
import type { StoryMark } from '../../shared/newsFeed'
import { describeError } from '../utils/ipcError'
import { buttonStyle, noteStyle } from './agentStyles'
import { AiHelpCard } from './AiHelpCard'
import { ContributionTable, CostTable, ExitsTable, ResultsTable, RollingTable } from './EventTables'
import { LIVE_BOARD_DAYS, loadLiveBars, readLiveAnswers, type LiveAnswers, type LiveBoardDeps } from './liveBoard'
import { loadQuantData, quantBacktests, type QuantData, type QuantFetch } from './quantState'

const deps: LiveBoardDeps = {
  listCalls: (filter) => window.api.ai.listCalls(filter),
  listEvents: (filter) => window.api.scanner.listEvents(filter),
  fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles
}

const quantFetch: QuantFetch = async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles

/** What the watch's recommendations earned, per model: the benchmark's tables over the events
 * the watch asked about live (./liveBoard.ts).
 *
 * OPENING IT READS TWO FILES. Scoring reads public candles, one request an event, so it waits for
 * a click. Nothing here asks a model, and nothing here trades. */
export function LiveBoardCard({
  title,
  models,
  refreshKey = 0
}: {
  title: string
  /** The models compared. Only events every one of them answered are. */
  models: string[]
  /** Changes when the watch has a new answer, so that what is on file is read again. */
  refreshKey?: number
}): React.JSX.Element | null {
  const [live, setLive] = useState<LiveAnswers | null>(null)
  const [bars, setBars] = useState<Record<string, Candle[]> | null>(null)
  // The two quant strategies' states at each event and their own runs, and the stories on file:
  // read with the candles, for "Does AI help?".
  const [quant, setQuant] = useState<{ data: QuantData; window: { startSec: number; endSec: number } } | null>(null)
  const [marks, setMarks] = useState<StoryMark[] | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const stop = useRef(false)
  const modelsKey = models.join('|')

  useEffect(() => {
    let cancelled = false
    stop.current = false
    if (models.length === 0) {
      setLive(null)
      return
    }
    void readLiveAnswers(models, Math.floor(Date.now() / 1000), deps).then(
      (next) => {
        if (cancelled) return
        setLive(next)
        setProblem(null)
      },
      (failure: unknown) => {
        if (!cancelled) setProblem(describeError(failure))
      }
    )
    return (): void => {
      cancelled = true
      // Leaving stops the candle fetches; what was fetched for a settled event is kept.
      stop.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on which models, not the array's identity
  }, [modelsKey, refreshKey])

  const summary = useMemo(
    () =>
      live === null || bars === null
        ? null
        : summarizeEventBenchmark({
            events: live.events,
            models,
            answers: live.answers,
            answeredAt: live.answeredAt,
            bars,
            quant: quant?.data.states,
            nowSec: Math.floor(Date.now() / 1000)
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `models` is what `live` was read for
    [live, bars, quant]
  )
  const news = useMemo(() => (live === null || marks === null ? null : eventNewsOf(live.events, marks)), [live, marks])
  const backtests = useMemo(() => (quant === null ? null : quantBacktests(quant.data, quant.window, Math.floor(Date.now() / 1000))), [quant])

  async function score(): Promise<void> {
    if (live === null || progress !== null) return
    stop.current = false
    setProblem(null)
    setProgress('Reading what followed each event…')
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const fetched = await loadLiveBars(live.events, nowSec, deps.fetchCandles, {
        shouldStop: () => stop.current,
        onProgress: (done, total) => setProgress(`Reading what followed each event: ${done} of ${total}`)
      })
      if (stop.current) return
      setBars(fetched)
      const span = { startSec: nowSec - LIVE_BOARD_DAYS * 86_400, endSec: nowSec }
      const data = await loadQuantData(live.events, span, quantFetch, {
        shouldStop: () => stop.current,
        onProgress: (done, total) => setProgress(`Reading the two strategies at each event: ${done} of ${total} pairs`)
      })
      if (stop.current) return
      setQuant({ data, window: span })
      try {
        setMarks(await window.api.feed.history(span.startSec - AI_HELP_NEWS_SECONDS, nowSec))
      } catch {
        setMarks(null)
      }
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setProgress(null)
    }
  }

  if (models.length === 0) return null
  const none = live !== null && live.events.length === 0

  return (
    <Card title={title}>
      {live === null ? (
        <p style={noteStyle}>{problem ?? 'Loading…'}</p>
      ) : none ? (
        <p style={noteStyle}>
          The watch has not put an event to {models.length === 1 ? describeDecider(models[0]) : 'these models'} in the last {LIVE_BOARD_DAYS} days, so there is nothing to score
          yet.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => void score()} disabled={progress !== null} style={buttonStyle(bars === null ? 'primary' : 'secondary', progress !== null)}>
              {bars === null ? 'Score them' : 'Score again'}
            </button>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              {progress ??
                `The watch has asked about ${live.events.length.toLocaleString()} ${live.events.length === 1 ? 'event' : 'events'} in the last ${LIVE_BOARD_DAYS} days.${
                  summary !== null ? ` Compared on ${summary.compared.toLocaleString()} of ${summary.sampled.toLocaleString()}: the events every model answered.` : ''
                }`}
            </span>
          </div>
          {live.missing > 0 && (
            <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
              {live.missing} more {live.missing === 1 ? 'event is' : 'events are'} left out: the watch asked about {live.missing === 1 ? 'it' : 'them'}, and the scanner&apos;s record of{' '}
              {live.missing === 1 ? 'it' : 'them'} is no longer on file.
            </p>
          )}
          {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.5rem' }}>{problem}</p>}
          {summary !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.9rem' }}>
              <ResultsTable title="Model" rows={summary.models} models />
              {quant !== null && <AiHelpCard summary={summary} events={live.events} news={news} backtests={backtests} failedPairs={quant.data.failed.length} />}
              <RollingTable rows={[...summary.models, ...summary.baselines]} nowSec={Math.floor(Date.now() / 1000)} />
              <ResultsTable title="Rule" rows={[...summary.baselines, summary.buyAndHold, ...summary.quant, ...summary.rules]} models={false} />
              {summary.contributions.length > 0 && <ContributionTable contributions={summary.contributions} models={summary.models} />}
              <ExitsTable rows={[...summary.models, ...summary.baselines, ...summary.rules]} />
              <CostTable rows={summary.models} />
            </div>
          )}
          <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
            <strong>Score them</strong> is free: it reads the minute candles after each event, one request of public candles an event. These are the benchmark&apos;s tables, over
            the events the watch asked about as they happened, and they differ from a benchmark in what a benchmark has to assume. Each answer is scored from the second its call
            finished, not from an assumed delay; and slippage is the larger of the rate for the pair&apos;s liquidity and half the spread the scanner saw on its book. Only the
            watch&apos;s own answers count: one bought later by pressing Ask arrived when a person got round to it. Only events every model answered are compared — with the first
            model asked alone, that is only the events it passed on. A recommendation still open, or with no candles yet, is unsettled and not a loss. <strong>Lately</strong>{' '}
            is the same closed trades, newest first: the last 10, 50 and 100 of them, and those of the last 7 and 30 days, beside the same events followed with no model.
          </p>
        </>
      )}
    </Card>
  )
}
