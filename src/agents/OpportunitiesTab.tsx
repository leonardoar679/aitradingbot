import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { describeAiOpportunityCost, type AiConfig } from '../../shared/aiCost'
import { AI_OPPORTUNITY_MAX_MODELS } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import type { AiOrderProposal } from '../../shared/aiProposal'
import { watchEventIdsToday, watchPausedModels } from '../../shared/aiWatch'
import { describeWatchPaperTally, watchPaperExecutors, watchPaperPause, watchPaperTally } from '../../shared/aiWatchPaper'
import type { ExecutorConfig, PaperAccount } from '../../shared/ipc'
import { describeEventType } from '../../shared/marketEvent'
import { healPaperPause, paperPauseBlock } from '../../shared/paperPause'
import { describeError } from '../utils/ipcError'
import { useNowSec } from '../utils/useNowSec'
import { useLiveMarket } from '../hooks/useLiveMarket'
import { useMarketResearch } from '../hooks/useMarketResearch'
import { useNewsFeed } from '../news/useNewsFeed'
import { useNewsReadings } from '../news/useNewsReadings'
import { buttonStyle, noteStyle } from './agentStyles'
import { OpportunityCard } from './OpportunityCard'
import { askModels, fetchEventQuestion, proposalForAnswer, type CandleFetch, type EventAnswer, type EventFeedItem } from './opportunities'
import { opportunityTableRows, tableSymbols } from './opportunityTable'
import { OpportunityTableCard } from './OpportunityTableCard'
import { useEventFeed } from './useEventFeed'
import { WatchCard } from './WatchCard'

const EVENTS_SHOWN = 20
/** How often the executors on file are read again, for the watch's own paper trades. */
const PAPER_REFRESH_MS = 30_000

const fetchCandles: CandleFetch = async (exchange, symbol, interval, startSec, endSec) =>
  (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles

/** Events the scanner raised, and what the models asked about each one recommended: the body of
 * the Opportunities page. What those recommendations went on to earn, and the journal of them,
 * are on Performance.
 *
 * OPENING THIS TAB ASKS NO MODEL. It reads the scanner's events, the answers already in the
 * ledger, and candles. A model is asked when Ask is pressed on a card, after a confirmation that
 * states the price of exactly those calls -- or by the watch, which is switched on from the card
 * at the top after a confirmation that states the most a day of it can cost (shared/aiWatch.ts).
 * The watch itself runs in OpportunityScheduler, whichever page is open; this tab shows what it
 * has asked.
 *
 * NOTHING HERE TRADES. "Paper trade" hands a filled-in order form to Strategies › Execution
 * (shared/aiProposal.ts); a person sets the amount and submits it there. The watch's own paper
 * trades (shared/aiWatchPaper.ts) are opened by OpportunityScheduler, not by this tab: here they
 * are switched on and off, and counted from the executors on file, which this tab only reads. */
export function OpportunitiesTab({
  onPrepareOrder
}: {
  /** Opens an executor form filled in from a recommendation. The form is on another page, so this
   * tab only hands the proposal up; it has no way to submit one. */
  onPrepareOrder?: (proposal: AiOrderProposal) => void
} = {}): React.JSX.Element {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [ticked, setTicked] = useState<string[]>([])
  const [busyEvent, setBusyEvent] = useState<string | null>(null)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [configProblem, setConfigProblem] = useState<string | null>(null)
  const [shown, setShown] = useState(EVENTS_SHOWN)
  const [paperAccount, setPaperAccount] = useState<PaperAccount | null | undefined>(undefined)
  const [paperRisk, setPaperRisk] = useState<unknown>(undefined)
  const [paperPause, setPaperPause] = useState<unknown>(undefined)
  const [executors, setExecutors] = useState<ExecutorConfig[]>([])
  const nowSec = useNowSec(true, 15_000)
  // The scanner's events, the answers held for them and the candles since: shared with Overview.
  const { events, scannerOn, calls, feed, bars, loadCalls, problem: feedProblem, watchAnswered } = useEventFeed(shown)
  const loadProblem = configProblem ?? feedProblem
  // The market's regime and each pair's day and week, and the news on the coins: for the table.
  const { state: research } = useMarketResearch()
  const news = useNewsFeed()
  const readings = useNewsReadings(news)

  useEffect(() => {
    let cancelled = false
    window.api.ai.getConfig().then(
      (nextConfig) => {
        if (cancelled) return
        setConfig(nextConfig)
        setTicked([nextConfig.defaultModel])
      },
      (failure: unknown) => {
        if (!cancelled) setConfigProblem(describeError(failure))
      }
    )
    return (): void => {
      cancelled = true
    }
  }, [])

  // The watch's own paper trades, read from the executors on file. Read only: this tab writes
  // none of it.
  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      void window.api.settings.get().then(
        (settings) => {
          if (cancelled) return
          setPaperAccount(settings.paperAccount ?? null)
          setPaperRisk(settings.paperRisk)
          setPaperPause(settings.paperPause)
          setExecutors(settings.executors)
        },
        () => undefined
      )
    }
    read()
    const timer = setInterval(read, PAPER_REFRESH_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [watchAnswered])

  function setProblem(eventId: string, text: string | null): void {
    setProblems((current) => {
      const next = { ...current }
      if (text === null) delete next[eventId]
      else next[eventId] = text
      return next
    })
  }

  async function ask(item: EventFeedItem, models: string[]): Promise<void> {
    if (models.length === 0 || busyEvent !== null) return
    const { event } = item
    setBusyEvent(event.id)
    setProblem(event.id, null)
    try {
      const question = await fetchEventQuestion(event, fetchCandles)
      // An event an announcement raised is asked about with the announcement in it, as the watch
      // asks about it; the main process looks the article up in what it read itself.
      const market = { exchange: event.exchange, symbol: event.symbol, ...question, ...(event.news !== undefined ? { newsId: event.news.articleId } : {}) }
      // Free: what is already held, and what each of the others is expected to cost.
      const peek = await window.api.ai.peekOpportunity({ ...market, models })
      const toAsk = peek.models.filter((model) => model.decision === null).map((model) => model.model)
      if (toAsk.length > 0) {
        const agreed = window.confirm(
          describeAiOpportunityCost({
            symbol: event.symbol,
            event: describeEventType(event.type).toLowerCase(),
            models: peek.models.map((model) => ({
              model: model.model,
              held: model.decision !== null,
              perCallCostUsd: model.perCallCostUsd,
              costBasis: model.costBasis,
              perCallLatencyMs: model.perCallLatencyMs
            })),
            budgetRemainingUsd: peek.budgetRemainingUsd
          })
        )
        if (!agreed) return
        const asked = await askModels(toAsk, (model) => window.api.ai.askOpportunity({ ...market, model, source: 'opportunity' }))
        const failed = asked.results.filter((result) => result.problem !== null)
        if (failed.length > 0) {
          setProblem(event.id, failed.map((result) => `${describeDecider(result.model)} did not answer: ${result.problem}`).join(' '))
        }
      }
      await loadCalls()
    } catch (failure) {
      setProblem(event.id, describeError(failure))
    } finally {
      setBusyEvent(null)
    }
  }

  async function paperTrade(item: EventFeedItem, answer: EventAnswer): Promise<void> {
    if (!onPrepareOrder) return
    const { event } = item
    setProblem(event.id, null)
    // The price now, so the form can say whether it enters at market or waits.
    const result = await proposalForAnswer(item, answer, async () => (await window.api.market.fetchTicker24h(event.exchange, event.symbol)).lastPrice)
    if ('problem' in result) {
      setProblem(event.id, result.problem)
      return
    }
    onPrepareOrder(result.proposal)
  }

  function toggle(model: string): void {
    setTicked((current) => (current.includes(model) ? current.filter((entry) => entry !== model) : [...current, model].slice(0, AI_OPPORTUNITY_MAX_MODELS)))
  }

  const enabled = config?.enabledModels ?? []
  // The live prices of the pairs in the table, those on offer first: each entry is checked against them.
  const live = useLiveMarket(useMemo(() => tableSymbols(feed, bars, nowSec), [feed, bars, nowSec]))
  const table = opportunityTableRows({
    feed,
    bars,
    live,
    pairs: research?.pairs ?? [],
    regime: research?.market?.regime ?? null,
    news,
    readings,
    nowSec,
    nowMs: Date.now(),
    btcLimitPct: config?.watchPaper.dropOnBtcMovePct,
    stakeQuote: config?.watchPaper.stakeQuote
  })
  // Models the watch has stopped asking today, read from the same rows that count its day.
  const paused = useMemo(() => watchPausedModels(calls, nowSec), [calls, nowSec])
  const watchTrades = useMemo(() => watchPaperExecutors(executors), [executors])
  const paperStanding = {
    hasAccount: paperAccount === undefined ? null : paperAccount !== null,
    open: watchTrades.filter((executor) => executor.status === 'active').map((executor) => executor.symbol),
    total: watchTrades.length,
    ended: describeWatchPaperTally(watchPaperTally(watchTrades)),
    // A losing run, which waits for Resume on Risk & Safety, before the pause that ends at midnight.
    pause:
      paperPauseBlock({ setting: healPaperPause(paperPause), executors: watchTrades, source: 'watch' }) ??
      (config === null ? null : watchPaperPause(watchTrades, config.watchPaper, nowSec)),
    risk: paperRisk,
    pauseSetting: paperPause
  }

  return (
    <>
      {config !== null && (
        <WatchCard
          config={config}
          onConfig={setConfig}
          scannerOn={scannerOn}
          events={events ?? []}
          takenToday={watchEventIdsToday(calls, nowSec).size}
          paused={config.watch.models.filter((model) => paused.has(model))}
          paper={paperStanding}
        />
      )}

      {events !== null && (
        <OpportunityTableCard
          onOffer={table.onOffer}
          recent={table.recent}
          nowSec={nowSec}
          news={news}
          risk={
            config === null || paperAccount === undefined
              ? null
              : { paperRisk, account: paperAccount, executors, stakeQuote: config.watchPaper.stakeQuote, btcLimitPct: config.watchPaper.dropOnBtcMovePct }
          }
          onPaperTrade={
            onPrepareOrder
              ? (item: EventFeedItem, answer: EventAnswer): void => {
                  void paperTrade(item, answer)
                }
              : undefined
          }
        />
      )}

      <Card title="Models to ask">
        {config === null ? (
          <p style={noteStyle}>{loadProblem ?? 'Loading…'}</p>
        ) : (
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {enabled.map((model) => (
              <label key={model} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={ticked.includes(model)} onChange={() => toggle(model)} />
                {describeDecider(model)}
              </label>
            ))}
          </div>
        )}
        <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
          Each ticked model is shown the same snapshot of an event and answers on its own; none sees another&apos;s answer.
          An answer is BUY, SELL or NO TRADE, and a call to trade names an entry range, a stop, a target, how long the entry
          stays valid and how long to hold. SELL is a short, which this app can only paper trade. Nothing is asked until
          you press Ask on an event, and the price of those calls is stated first. Models are enabled under Settings › AI.
        </p>
      </Card>

      {scannerOn === false && (
        <p style={{ ...noteStyle, color: 'var(--gold)' }}>
          The scanner is off, so no new events are being raised. Switch it on under Settings › Market. Events it raised earlier are
          still listed here.
        </p>
      )}

      {events !== null && feed.length === 0 && (
        <Card title="Events">
          <p style={noteStyle}>
            No event has been raised yet. The scanner records a pair when its last fifteen minutes are unusual enough to be
            a candidate; on sixty pairs that is a few an hour.
          </p>
        </Card>
      )}

      {feed.map((item) => (
        <OpportunityCard
          key={item.event.id}
          item={item}
          bars={bars.get(item.event.id)}
          nowSec={nowSec}
          toAsk={ticked.filter((model) => !item.answers.some((answer) => answer.model === model))}
          busy={busyEvent === item.event.id}
          problem={problems[item.event.id] ?? null}
          onAsk={() => void ask(item, ticked.filter((model) => !item.answers.some((answer) => answer.model === model)))}
          onPaperTrade={
            onPrepareOrder
              ? (answer: EventAnswer): void => {
                  void paperTrade(item, answer)
                }
              : undefined
          }
        />
      ))}

      {events !== null && events.length > shown && (
        <button onClick={() => setShown((count) => count + EVENTS_SHOWN)} style={{ ...buttonStyle('secondary'), alignSelf: 'flex-start' }}>
          Show {Math.min(EVENTS_SHOWN, events.length - shown)} more
        </button>
      )}

      <p style={noteStyle}>
        What the watch&apos;s recommendations went on to earn, over its last trades and days, and the journal of every one,
        are on Performance.
      </p>

      <p style={noteStyle}>
        What a recommendation has done is worked out from 1-minute candles each time this tab is looked at, never stored.
        An answer can only be acted on from the first minute that opens after it arrived, so a slower model enters later.
        An entry fills the first time the price trades in its range while it is valid, at the open if that is inside the
        range and otherwise at the nearer edge; a bar that touches both the stop and the target counts as the stop; fees
        are paid on both fills and slippage on every market fill. An event is something unusual, not a signal
        (research/EVENTS.md), and a model&apos;s confidence is not a probability of profit.
      </p>
    </>
  )
}
