import { useEffect } from 'react'
import type { MarketEvent } from '../../shared/marketEvent'
import { watchPass, type WatchDeps } from './opportunityWatch'

const deps: WatchDeps = {
  getConfig: () => window.api.ai.getConfig(),
  listCalls: (filter) => window.api.ai.listCalls(filter),
  fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles,
  ask: (request) => window.api.ai.askOpportunity(request),
  // A desktop that cannot show it is not a reason to fail the pass that got the answer.
  notify: (title, body) => void window.api.notify(title, body).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000)
}

/** Headless — mounted once in App.tsx, like PortfolioScheduler. Runs the watch (shared/aiWatch.ts)
 * whichever page is open: each time the scanner finishes a pass, its events are looked at, and
 * the ones the watch should ask about are put to its models.
 *
 * While the watch is off this reads one setting a scanner pass and asks nothing. It never trades:
 * what it produces is answers on the Opportunities tab and a desktop notice. */
export function OpportunityScheduler(): null {
  useEffect(() => {
    let cancelled = false
    const look = (events: MarketEvent[]): void => {
      if (cancelled) return
      // A pass that could not read the setting or the ledger asked nothing; the next one tries again.
      void watchPass(events, deps).catch((error: unknown) => console.error('The watch could not look at the events raised:', error))
    }
    void window.api.scanner
      .getState()
      .then((state) => look(state.recentEvents))
      .catch(() => undefined)
    const stop = window.api.scanner.onUpdate((state) => look(state.recentEvents))
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  return null
}
