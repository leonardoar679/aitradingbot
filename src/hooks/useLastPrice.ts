import { useEffect, useState } from 'react'
import type { Exchange, Ticker24h } from '../../shared/ipc'

/** Live last price for one symbol, seeded from a REST snapshot and then kept fresh by the ticker
 * websocket.
 *
 * Important caveat, and the reason for the symbol filter below: marketService keeps exactly ONE
 * global ticker stream, and every subscribeTicker call tears down the previous one. When several
 * of these hooks are mounted at once (the Positions page renders one per row), only the
 * last-subscribed symbol actually streams -- and updates are broadcast to every listener with no
 * symbol attached to them. Without the filter, a BTC row would start displaying ETH's price
 * against BTC's cost basis the moment the first tick arrived, quietly reporting a wrong mark and
 * a wrong unrealized P&L on real-money positions.
 *
 * Filtering means a row whose symbol isn't the one currently streaming simply keeps its REST
 * snapshot instead of updating live: stale, but correct and correctly labelled, which is the right
 * failure mode for a number someone might trade against. Making every row stream at once needs
 * multi-symbol subscription support in marketService and each exchange adapter. */
export function useLastPrice(exchange: Exchange, symbol: string): number | null {
  const [price, setPrice] = useState<number | null>(null)

  useEffect(() => {
    setPrice(null)
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    async function start(): Promise<void> {
      try {
        const snapshot = await window.api.market.subscribeTicker(exchange, symbol)
        if (cancelled) return
        setPrice(snapshot.lastPrice)
        unsubscribe = window.api.market.onTickerUpdate((t: Ticker24h) => {
          if (t.symbol !== symbol) return
          setPrice(t.lastPrice)
        })
      } catch (error) {
        console.error('Failed to load ticker:', error)
      }
    }
    void start()

    return () => {
      cancelled = true
      unsubscribe?.()
      void window.api.market.unsubscribeTicker()
    }
  }, [exchange, symbol])

  return price
}
