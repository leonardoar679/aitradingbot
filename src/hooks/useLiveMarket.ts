import { useEffect, useState } from 'react'
import type { LiveState } from '../../shared/liveMarket'

/** Live prices for `symbols` -- the pairs a page is showing a recommendation on -- from the one
 * public socket the main process holds (electron/services/liveMarketService.ts), kept current four
 * times a second at most. The list replaces the one asked for before; leaving the page stops it.
 * Null until first read. */
export function useLiveMarket(symbols: string[]): LiveState | null {
  const [state, setState] = useState<LiveState | null>(null)
  const key = symbols.join(',')

  useEffect(() => {
    void window.api.market.setLiveInterest(key === '' ? [] : key.split(',')).catch(() => undefined)
  }, [key])

  useEffect(() => {
    let cancelled = false
    window.api.market.liveState().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      () => undefined
    )
    const stop = window.api.market.onLiveUpdate((next) => {
      if (!cancelled) setState(next)
    })
    return (): void => {
      cancelled = true
      stop()
      // Left: the pairs this page showed are no longer wanted.
      void window.api.market.setLiveInterest([]).catch(() => undefined)
    }
  }, [])

  return state
}
