import { useEffect, useState } from 'react'
import type { Exchange, Ticker24h } from '../../shared/ipc'

/** How often a row that isn't the one currently streaming re-reads its price over REST. */
const REST_REFRESH_MS = 15_000

/** Live last price for one symbol, seeded from a REST snapshot, kept fresh by the ticker
 * websocket when this symbol is the one streaming, and by a REST poll when it isn't.
 *
 * The reason for both, and for the symbol filter below: marketService keeps exactly ONE global
 * ticker stream, and every subscribeTicker call tears down the previous one. When several of
 * these hooks are mounted at once (the Positions page renders one per row, across both the
 * real-money and Inventory tables), only the last-subscribed symbol actually streams -- and
 * updates are broadcast to every listener with no symbol attached to them. Without the filter, a
 * BTC row would start displaying ETH's price against BTC's cost basis the moment the first tick
 * arrived, quietly reporting a wrong mark and a wrong unrealized P&L on real-money positions.
 *
 * Filtering alone left those rows frozen at whatever price they happened to mount with -- for a
 * Positions tab left open, that is a mark from hours ago driving a P&L figure with nothing on
 * screen admitting it. The REST poll fixes that without needing multi-symbol subscription
 * support in marketService and all eight exchange adapters: every row is correct to within
 * REST_REFRESH_MS whether or not it owns the socket.
 *
 * A row that IS streaming skips the poll while ticks keep arriving, so the socket stays the
 * source of truth for it rather than being overwritten by a slightly older REST read. */
export function useLastPrice(exchange: Exchange, symbol: string): number | null {
  const [price, setPrice] = useState<number | null>(null)

  useEffect(() => {
    setPrice(null)
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let lastTickAt = 0

    async function refreshFromRest(): Promise<void> {
      // Streaming for this symbol is fresher than anything REST can return, so leave it alone.
      if (Date.now() - lastTickAt < REST_REFRESH_MS) return
      try {
        const ticker = await window.api.market.fetchTicker24h(exchange, symbol)
        if (!cancelled) setPrice(ticker.lastPrice)
      } catch (error) {
        // A failed refresh keeps the previous price rather than blanking it -- the last known
        // mark is more useful than an em dash, and the next tick is REST_REFRESH_MS away.
        console.error('Failed to refresh ticker:', error)
      }
    }

    async function start(): Promise<void> {
      try {
        const snapshot = await window.api.market.subscribeTicker(exchange, symbol)
        if (cancelled) return
        setPrice(snapshot.lastPrice)
        unsubscribe = window.api.market.onTickerUpdate((t: Ticker24h) => {
          if (t.symbol !== symbol) return
          lastTickAt = Date.now()
          setPrice(t.lastPrice)
        })
      } catch (error) {
        console.error('Failed to load ticker:', error)
        // Even if the subscription failed outright, the poll below still keeps this row honest.
      }
    }
    void start()
    timer = setInterval(() => void refreshFromRest(), REST_REFRESH_MS)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      unsubscribe?.()
      void window.api.market.unsubscribeTicker()
    }
  }, [exchange, symbol])

  return price
}
