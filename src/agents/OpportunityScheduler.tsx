import { noticeI18n } from '../i18n/current'
import { useEffect } from 'react'
import type { EventLife, MarketEvent } from '../../shared/marketEvent'
import { sweepRestartMisses, watchPass, type WatchDeps } from './opportunityWatch'
import { openWatchPaperTrade, settleWatchPaperTrades, watchPaperBrowserDeps, watchTradedEventIds } from './watchPaperTrade'

/** How often the watch's own paper trades are looked at for one that has closed. A minute: a
 * position is judged on minutes that have closed. */
const PAPER_SETTLE_MS = 60_000

/** How soon the watch looks again at an event whose candles could not be read. A pass the scanner
 * finishes would bring it back within the minute, but an announcement's event raised with the
 * scanner off has no pass after it: without this, one failed read would leave it unasked. */
const RETRY_MS = 20_000

const deps: WatchDeps = {
  getConfig: () => window.api.ai.getConfig(),
  listCalls: (filter) => window.api.ai.listCalls(filter),
  fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles,
  ask: (request) => window.api.ai.askOpportunity(request),
  // A desktop that cannot show it is not a reason to fail the pass that got the answer.
  notify: (title, body, extra) => void window.api.notify(title, body, extra?.severity, extra).catch(() => undefined),
  // Its notices and the Watch card's line in the person's language (V6 Stage 14).
  i18n: noticeI18n,
  nowSec: () => Math.floor(Date.now() / 1000),
  // Paper only, and only when the user has switched it on (./watchPaperTrade.ts).
  paperTrade: (event, decision, byVote, vote) => openWatchPaperTrade(event, decision, watchPaperBrowserDeps, { byVote: byVote === true, vote }),
  // A refusal written to the records on file (shared/records.ts), for the session report after a
  // restart and the trade's timeline. A record; nothing reads it to decide anything.
  recordRefusal: (refusal) => void window.api.records.refusal(refusal).catch(() => undefined)
}

/** Headless — mounted once in App.tsx, like PortfolioScheduler. Runs the watch (shared/aiWatch.ts)
 * whichever page is open: each time the scanner finishes a pass, its events are looked at, and
 * the ones the watch should ask about are put to its models.
 *
 * While the watch is off this reads one setting a scanner pass and asks nothing. It places nothing
 * real: what it produces is answers on the Opportunities page, a desktop notice and, when the user
 * has switched that on, a paper position -- which it also stops and settles once it has closed. */
export function OpportunityScheduler(): null {
  useEffect(() => {
    let cancelled = false
    let again: ReturnType<typeof setTimeout> | null = null
    const look = (events: MarketEvent[], lives: Record<string, EventLife> = {}): void => {
      if (cancelled) return
      // A pass that could not read the setting or the ledger asked nothing; the next one tries again.
      void watchPass(events, deps, lives)
        .then((result) => {
          // An event whose candles could not be read is looked at again, once the scanner's events
          // are read afresh, while it is still fresh: the pass will not take up a stale one.
          if (result.retry.length === 0 || again !== null || cancelled) return
          again = setTimeout(() => {
            again = null
            void window.api.scanner
              .getState()
              .then((state) => look(state.recentEvents, state.lives))
              .catch(() => undefined)
          }, RETRY_MS)
        })
        .catch((error: unknown) => console.error('The watch could not look at the events raised:', error))
    }
    // The record whole across a restart (shared/restartMisses.ts; the V5 document, §94): an event
    // answered before this start with an answer to act on, no trade and no refusal is written as a
    // refusal at stage restart, before the first pass. A record; the event is not asked again
    // either way.
    void sweepRestartMisses({
      listCalls: deps.listCalls,
      listRefusals: (filter) => window.api.records.refusals(filter),
      tradedEventIds: watchTradedEventIds,
      recordRefusal: deps.recordRefusal,
      nowSec: deps.nowSec
    })
      .then((misses) => {
        if (misses.length > 0) console.log(`The restart sweep wrote ${misses.length} refusal(s) for answers the app was not running to act on.`)
      })
      .catch((error: unknown) => console.error('The restart sweep failed:', error))
    void window.api.scanner
      .getState()
      .then((state) => look(state.recentEvents, state.lives))
      .catch(() => undefined)
    const stop = window.api.scanner.onUpdate((state) => look(state.recentEvents, state.lives))
    // On its own clock, not the scanner's: a paper trade opened yesterday still has to be closed
    // with the scanner off, and with paper trades themselves since switched off.
    const settle = (): void => {
      if (cancelled) return
      void settleWatchPaperTrades(watchPaperBrowserDeps).catch((error: unknown) => console.error('The watch could not look at its paper trades:', error))
    }
    settle()
    const timer = setInterval(settle, PAPER_SETTLE_MS)
    return (): void => {
      cancelled = true
      stop()
      clearInterval(timer)
      if (again !== null) clearTimeout(again)
    }
  }, [])

  return null
}
