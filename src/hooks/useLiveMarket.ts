import { useEffect, useState } from 'react'
import type { LiveConnection, LiveState } from '../../shared/liveMarket'

/** The pairs each card on screen wants streamed, by the card: the stream is asked for all of them at
 * once, so that two cards on one page -- Home's prediction and its opportunity -- do not take the
 * stream from each other (13 October 2026, V6 Stage 10). */
const wanted = new Map<number, string[]>()
let nextCard = 0

function askStream(): void {
  const symbols = [...new Set([...wanted.values()].flat())]
  void window.api.market.setLiveInterest(symbols).catch(() => undefined)
}

/** Live prices for `symbols` -- the pairs a card is showing a recommendation on -- from the one public
 * socket the main process holds (electron/services/liveMarketService.ts), kept current four times a
 * second at most. With the other cards on screen, the list replaces the one this card asked for
 * before; a card taken off screen stops its own. Null until first read. */
export function useLiveMarket(symbols: string[]): LiveState | null {
  const [state, setState] = useState<LiveState | null>(null)
  const [card] = useState(() => ++nextCard)
  const key = symbols.join(',')

  useEffect(() => {
    wanted.set(card, key === '' ? [] : key.split(','))
    askStream()
  }, [card, key])

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
      // Off screen: the pairs this card showed are no longer wanted, the other cards' still are.
      wanted.delete(card)
      askStream()
    }
  }, [card])

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
