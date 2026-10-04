import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { describeAiOpportunityCost, type AiConfig } from '../../shared/aiCost'
import type { AiCallRecord } from '../../shared/aiLedger'
import { AI_OPPORTUNITY_MAX_MODELS, AI_OPPORTUNITY_PROMPT_VERSION } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import { buildOpportunityProposal, opportunityProposalProblem, type AiOrderProposal } from '../../shared/aiProposal'
import { watchEventIdsToday } from '../../shared/aiWatch'
import type { Candle } from '../../shared/ipc'
import { describeEventType, type MarketEvent } from '../../shared/marketEvent'
import { describeError } from '../utils/ipcError'
import { useNowSec } from '../utils/useNowSec'
import { buttonStyle, noteStyle } from './agentStyles'
import { LiveBoardCard } from './LiveBoardCard'
import { OpportunityCard } from './OpportunityCard'
import { askModels, assembleFeed, fetchEventQuestion, loadFeedBars, type CandleFetch, type EventAnswer, type EventFeedItem } from './opportunities'
import { getWatchActivity, subscribeWatchActivity } from './opportunityWatch'
import { WatchCard } from './WatchCard'

const EVENTS_SHOWN = 20
/** How many answers are read back from the ledger. One row an answer, newest first. */
const CALLS_READ = 5000
/** A recommendation changes at most once a minute: when a minute closes. */
const OUTCOME_REFRESH_SEC = 60

const fetchCandles: CandleFetch = async (exchange, symbol, interval, startSec, endSec) =>
  (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles

/** Events the scanner raised, and what the models asked about each one recommended.
 *
 * OPENING THIS TAB ASKS NO MODEL. It reads the scanner's events, the answers already in the
 * ledger, and candles. A model is asked when Ask is pressed on a card, after a confirmation that
 * states the price of exactly those calls -- or by the watch, which is switched on from the card
 * at the top after a confirmation that states the most a day of it can cost (shared/aiWatch.ts).
 * The watch itself runs in OpportunityScheduler, whichever page is open; this tab shows what it
 * has asked.
 *
 * NOTHING HERE TRADES. "Paper trade" hands a filled-in order form to the Executors page
 * (shared/aiProposal.ts); a person sets the amount and submits it there. */
export function OpportunitiesTab({
  onPrepareOrder
}: {
  /** Opens an executor form filled in from a recommendation. The form is on another page, so this
   * tab only hands the proposal up; it has no way to submit one. */
  onPrepareOrder?: (proposal: AiOrderProposal) => void
} = {}): React.JSX.Element {
  const [events, setEvents] = useState<MarketEvent[] | null>(null)
  const [scannerOn, setScannerOn] = useState<boolean | null>(null)
  const [calls, setCalls] = useState<AiCallRecord[]>([])
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [ticked, setTicked] = useState<string[]>([])
  const [bars, setBars] = useState<Map<string, Candle[]>>(new Map())
  const [busyEvent, setBusyEvent] = useState<string | null>(null)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [loadProblem, setLoadProblem] = useState<string | null>(null)
  const [shown, setShown] = useState(EVENTS_SHOWN)
  const [watchAnswered, setWatchAnswered] = useState(getWatchActivity().answered)
  const nowSec = useNowSec(true, 15_000)
  const barsAt = useRef(0)

  const loadCalls = useCallback(async (): Promise<void> => {
    // By prompt, not by where the call came from: an answer a benchmark bought for an event is
    // the same answer, and belongs on that event's card.
    const page = await window.api.ai.listCalls({ promptVersion: AI_OPPORTUNITY_PROMPT_VERSION, limit: CALLS_READ })
    setCalls(page.rows)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const [state, nextConfig] = await Promise.all([window.api.scanner.getState(), window.api.ai.getConfig()])
        if (cancelled) return
        setEvents(state.recentEvents)
        setScannerOn(state.config.enabled)
        setConfig(nextConfig)
        setTicked([nextConfig.defaultModel])
        await loadCalls()
      } catch (failure) {
        if (!cancelled) setLoadProblem(describeError(failure))
      }
    })()
    const stop = window.api.scanner.onUpdate((state) => {
      if (cancelled) return
      setEvents(state.recentEvents)
      setScannerOn(state.config.enabled)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [loadCalls])

  // The watch's answers arrive with nobody pressing anything here, so the tab is told.
  useEffect(() => subscribeWatchActivity((activity) => setWatchAnswered(activity.answered)), [])
  useEffect(() => {
    if (watchAnswered > 0) void loadCalls().catch(() => undefined)
  }, [watchAnswered, loadCalls])

  const feed = useMemo(() => assembleFeed((events ?? []).slice(0, shown), calls), [events, calls, shown])
  // Which events have a trade on them, and for which models: what the outcome fetch depends on.
  const tradeKey = feed.map((item) => `${item.event.id}:${item.answers.map((answer) => answer.model).join(',')}`).join('|')

  const refreshBars = useCallback(async (items: EventFeedItem[]): Promise<void> => {
    barsAt.current = Math.floor(Date.now() / 1000)
    setBars(await loadFeedBars(items, barsAt.current, fetchCandles))
  }, [])

  useEffect(() => {
    void refreshBars(feed)
    const timer = setInterval(() => {
      if (Math.floor(Date.now() / 1000) - barsAt.current >= OUTCOME_REFRESH_SEC) void refreshBars(feed)
    }, 15_000)
    return (): void => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what is on the cards, not the array's identity
  }, [tradeKey, refreshBars])

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
      const market = { exchange: event.exchange, symbol: event.symbol, ...question }
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
    // The price now, so the form can say whether it enters at market or waits. Without one the
    // event's own price stands in, which is the last the model saw.
    let lastPrice: number | null = null
    try {
      lastPrice = (await window.api.market.fetchTicker24h(event.exchange, event.symbol)).lastPrice
    } catch {
      lastPrice = null
    }
    const now = Math.floor(Date.now() / 1000)
    const proposal = buildOpportunityProposal({ event, decision: answer.decision, nowSec: now, lastPrice })
    if (proposal === null) {
      setProblem(event.id, opportunityProposalProblem(event.time, answer.decision, now, lastPrice) ?? 'No order form can be made from this recommendation.')
      return
    }
    onPrepareOrder(proposal)
  }

  function toggle(model: string): void {
    setTicked((current) => (current.includes(model) ? current.filter((entry) => entry !== model) : [...current, model].slice(0, AI_OPPORTUNITY_MAX_MODELS)))
  }

  const enabled = config?.enabledModels ?? []

  return (
    <>
      {config !== null && (
        <WatchCard config={config} onConfig={setConfig} scannerOn={scannerOn} events={events ?? []} takenToday={watchEventIdsToday(calls, nowSec).size} />
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
          you press Ask on an event, and the price of those calls is stated first. Models are enabled under Models.
        </p>
      </Card>

      {scannerOn === false && (
        <p style={{ ...noteStyle, color: 'var(--gold)' }}>
          The scanner is off, so no new events are being raised. Switch it on under Explorer. Events it raised earlier are
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

      {config !== null && <LiveBoardCard title="What the watch's recommendations earned" models={config.watch.models} refreshKey={watchAnswered} />}

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
