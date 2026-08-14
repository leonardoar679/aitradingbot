import { useEffect } from 'react'
import { computePortfolioSnapshot } from './computePortfolioSnapshot'
import { pushPortfolioSnapshot } from './portfolioStore'

// Longer than the 60s cadence individual bot/executor cards use -- this one runs continuously in
// the background across the *entire* bots+executors set on every tick, not just one visible card.
const POLL_MS = 120_000

/** Headless — mounted once in App.tsx, same pattern as ControllerScheduler/RoutineScheduler.
 * Keeps recording portfolio snapshots regardless of which page is open; otherwise the Portfolio
 * Evolution chart would have large gaps whenever the user wasn't looking at Portfolio, which
 * would misleadingly look like "nothing changed" rather than "nobody was watching." */
export function PortfolioScheduler(): null {
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll(): Promise<void> {
      try {
        const snapshot = await computePortfolioSnapshot()
        if (!cancelled) pushPortfolioSnapshot(snapshot)
      } catch (error) {
        console.error('Failed to compute portfolio snapshot:', error)
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS)
      }
    }

    void poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return null
}
