import { useEffect } from 'react'
import { labTraderBrowserDeps, openLabTrades, settleLabTrades, type LabPassResult } from './labTrader'

/** How often the laboratory's own paper trades are looked at for one that has closed: a minute, as a
 * position is judged on minutes that have closed. */
const SETTLE_MS = 60_000

/** What the laboratory's last pass did, for its card: read by PaperLabCard. */
let last: { at: number; result: LabPassResult } | null = null
const listeners = new Set<() => void>()

export function lastLabPass(): { at: number; result: LabPassResult } | null {
  return last
}

export function onLabPass(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Headless -- mounted once in App.tsx, like the forecast trader's scheduler. After each of the forecast's
 * passes, the paper laboratory (./labTrader.ts) opens what its strategies switched on may, on paper, and
 * every minute it settles what has closed. With every strategy off, a pass reads one setting and opens
 * nothing. It places nothing real. */
export function LabTraderScheduler(): null {
  useEffect(() => {
    let cancelled = false
    let running = false
    const pass = (): void => {
      if (cancelled || running) return
      running = true
      void openLabTrades(labTraderBrowserDeps)
        .then((result) => {
          last = { at: Math.floor(Date.now() / 1000), result }
          for (const listener of listeners) listener()
        })
        .catch((error: unknown) => console.error('The paper laboratory could not look at the decisions:', error))
        .finally(() => {
          running = false
        })
    }
    const settle = (): void => {
      void settleLabTrades(labTraderBrowserDeps).catch((error: unknown) => console.error('The paper laboratory could not settle its trades:', error))
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
