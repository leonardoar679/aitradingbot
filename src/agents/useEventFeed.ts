import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiCallRecord } from '../../shared/aiLedger'
import { AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS } from '../../shared/aiOpportunity'
import type { Candle } from '../../shared/ipc'
import type { MarketEvent } from '../../shared/marketEvent'
import { describeError } from '../utils/ipcError'
import { assembleFeed, loadFeedBars, type CandleFetch, type EventFeedItem } from './opportunities'
import { getWatchActivity, subscribeWatchActivity } from './opportunityWatch'

/** How many answers are read back from the ledger. One row an answer, newest first. */
const CALLS_READ = 5000
/** A recommendation changes at most once a minute: when a minute closes. */
const OUTCOME_REFRESH_SEC = 60

const fetchCandles: CandleFetch = async (exchange, symbol, interval, startSec, endSec) =>
  (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles

export interface EventFeed {
  /** Newest first. Null until the scanner has been read. */
  events: MarketEvent[] | null
  scannerOn: boolean | null
  calls: AiCallRecord[]
  /** The newest `shown` events, each with the answers held for it. */
  feed: EventFeedItem[]
  /** The minute candles after each event with a trade to score, by event id. */
  bars: Map<string, Candle[]>
  /** Reads the ledger again, after a page has asked something. */
  loadCalls: () => Promise<void>
  /** Why the scanner or the ledger could not be read, or null. */
  problem: string | null
  /** How many answers the watch has had this session: changes when it answers with nobody looking. */
  watchAnswered: number
}

/** The scanner's events, the answers the ledger holds for them, and the candles that say what each
 * recommendation has done: what Opportunities lists and what Overview leads with.
 *
 * READING THIS ASKS NO MODEL. It reads the scanner's state, the call ledger and public candles. */
export function useEventFeed(shown: number): EventFeed {
  const [events, setEvents] = useState<MarketEvent[] | null>(null)
  const [scannerOn, setScannerOn] = useState<boolean | null>(null)
  const [calls, setCalls] = useState<AiCallRecord[]>([])
  const [bars, setBars] = useState<Map<string, Candle[]>>(new Map())
  const [problem, setProblem] = useState<string | null>(null)
  const [watchAnswered, setWatchAnswered] = useState(getWatchActivity().answered)
  const barsAt = useRef(0)

  const loadCalls = useCallback(async (): Promise<void> => {
    // By prompt, not by where the call came from: an answer a benchmark bought for an event is
    // the same answer, and belongs on that event's card.
    const page = await window.api.ai.listCalls({ promptVersions: AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS, limit: CALLS_READ })
    setCalls(page.rows)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const state = await window.api.scanner.getState()
        if (cancelled) return
        setEvents(state.recentEvents)
        setScannerOn(state.config.enabled)
        await loadCalls()
      } catch (failure) {
        if (!cancelled) setProblem(describeError(failure))
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

  // The watch's answers arrive with nobody pressing anything, so the feed is told.
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

  return { events, scannerOn, calls, feed, bars, loadCalls, problem, watchAnswered }
}
