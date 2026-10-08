import { useEffect, useState } from 'react'
import type { HealthState } from '../../shared/exchangeHealth'

/** The exchange's health as the main process measures it (electron/services/exchangeHealthService.ts),
 * read once and then as each measurement arrives. Null until first read. */
export function useExchangeHealth(): HealthState | null {
  const [state, setState] = useState<HealthState | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.health.state().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      () => undefined
    )
    const stop = window.api.health.onUpdate((next) => {
      if (!cancelled) setState(next)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  return state
}
