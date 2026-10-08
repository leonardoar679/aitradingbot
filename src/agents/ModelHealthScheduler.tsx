import { useEffect } from 'react'
import { lookAtModelHealth, type ModelHealthDeps } from './modelHealthWatch'

/** How long after the app opens the first look is taken: after the scanner and the feed have
 * settled, and never in the way of the first minute. */
export const HEALTH_FIRST_MS = 3 * 60_000
/** Once a day after that: the notice it can raise is told once a day, and the record it reads
 * changes by the day. */
export const HEALTH_EVERY_MS = 24 * 3600_000

const deps: ModelHealthDeps = {
  getConfig: () => window.api.ai.getConfig(),
  listCalls: (filter) => window.api.ai.listCalls(filter),
  listEvents: (filter) => window.api.scanner.listEvents(filter),
  fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles,
  // A desktop that cannot show it is not a reason to fail the look.
  notify: (title, body, extra) => void window.api.notify(title, body, extra?.severity, extra).catch(() => undefined),
  nowSec: () => Math.floor(Date.now() / 1000)
}

/** Headless — mounted once in App.tsx, like OpportunityScheduler. Takes the daily look at each of
 * the watch's models (./modelHealthWatch.ts): three minutes after the app opens, then once a day.
 * It reads, marks and tells; it asks nothing and switches nothing off. */
export function ModelHealthScheduler(): null {
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const look = (): void => {
      if (cancelled) return
      void lookAtModelHealth(deps)
        .catch((error: unknown) => console.error("The models' health could not be read:", error))
        .finally(() => {
          if (!cancelled) timer = setTimeout(look, HEALTH_EVERY_MS)
        })
    }
    timer = setTimeout(look, HEALTH_FIRST_MS)
    return (): void => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
  return null
}
