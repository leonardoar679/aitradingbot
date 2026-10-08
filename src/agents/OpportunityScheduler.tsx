import { useEffect } from 'react'
import type { MarketEvent } from '../../shared/marketEvent'
import { watchPass, type WatchDeps } from './opportunityWatch'
import { openWatchPaperTrade, settleWatchPaperTrades, watchPaperBrowserDeps } from './watchPaperTrade'

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
  notify: (title, body) => void window.api.notify(title, body).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000),
  // Paper only, and only when the user has switched it on (./watchPaperTrade.ts).
  paperTrade: (event, decision) => openWatchPaperTrade(event, decision, watchPaperBrowserDeps),
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
    const look = (events: MarketEvent[]): void => {
      if (cancelled) return
      // A pass that could not read the setting or the ledger asked nothing; the next one tries again.
      void watchPass(events, deps)
        .then((result) => {
          // An event whose candles could not be read is looked at again, once the scanner's events
          // are read afresh, while it is still fresh: the pass will not take up a stale one.
          if (result.retry.length === 0 || again !== null || cancelled) return
          again = setTimeout(() => {
            again = null
            void window.api.scanner
              .getState()
              .then((state) => look(state.recentEvents))
              .catch(() => undefined)
          }, RETRY_MS)
        })
        .catch((error: unknown) => console.error('The watch could not look at the events raised:', error))
    }
    void window.api.scanner
      .getState()
      .then((state) => look(state.recentEvents))
      .catch(() => undefined)
    const stop = window.api.scanner.onUpdate((state) => look(state.recentEvents))
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
