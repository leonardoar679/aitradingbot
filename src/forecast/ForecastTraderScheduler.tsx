import { useEffect } from 'react'
import { forecastTraderBrowserDeps, openForecastTrades, settleForecastTrades, type ForecastTraderResult } from './forecastTrader'

/** How often the trader's own paper trades are looked at for one that has closed: a minute, as a
 * position is judged on minutes that have closed. */
const SETTLE_MS = 60_000

/** What the trader's last pass did, for its card: read by ForecastTraderCard. */
let last: { at: number; result: ForecastTraderResult } | null = null
const listeners = new Set<() => void>()

export function lastForecastTraderPass(): { at: number; result: ForecastTraderResult } | null {
  return last
}

export function onForecastTraderPass(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Headless -- mounted once in App.tsx, like the watch's scheduler. After each of the forecast's passes,
 * the forecast trader (./forecastTrader.ts) opens what it may on paper, and every minute it settles
 * what has closed. Switched off, a pass reads one setting and opens nothing. It places nothing real. */
export function ForecastTraderScheduler(): null {
  useEffect(() => {
    let cancelled = false
    let running = false
    const pass = (): void => {
      if (cancelled || running) return
      running = true
      void openForecastTrades(forecastTraderBrowserDeps)
        .then((result) => {
          last = { at: Math.floor(Date.now() / 1000), result }
          for (const listener of listeners) listener()
        })
        .catch((error: unknown) => console.error('The forecast trader could not look at the decisions:', error))
        .finally(() => {
          running = false
        })
    }
    const settle = (): void => {
      void settleForecastTrades(forecastTraderBrowserDeps).catch((error: unknown) => console.error('The forecast trader could not settle its trades:', error))
    }
    const stop = window.api.forecast.onUpdate(() => pass())
    const timer = setInterval(settle, SETTLE_MS)
    settle()
    return (): void => {
      cancelled = true
      stop()
      clearInterval(timer)
    }
  }, [])
  return null
}
