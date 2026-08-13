import { useEffect, useState } from 'react'
import type { Exchange, Ticker24h } from '../../shared/ipc'

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
        unsubscribe = window.api.market.onTickerUpdate((t: Ticker24h) => setPrice(t.lastPrice))
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
