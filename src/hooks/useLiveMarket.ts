import { useEffect, useState } from 'react'
import type { LiveConnection, LiveState } from '../../shared/liveMarket'

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

/** The socket's state alone, for the bar on every page: it asks for no pair, and leaves the page's
 * interest alone. Null until first read. */
export function useLiveConnection(): LiveConnection | null {
  const [connection, setConnection] = useState<LiveConnection | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.market.liveState().then(
      (next) => {
        if (!cancelled) setConnection(next.connection)
      },
      () => undefined
    )
    const stop = window.api.market.onLiveUpdate((next) => {
      if (!cancelled) setConnection(next.connection)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  return connection
}
