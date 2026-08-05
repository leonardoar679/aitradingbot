import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import type { PriceUpdate } from '../../shared/ipc'

const SYMBOL = 'BTC-USD'

export function PriceChart(): React.JSX.Element {
  const [latest, setLatest] = useState<PriceUpdate | null>(null)

  useEffect(() => {
    const unsubscribeListener = window.api.market.onPriceUpdate((update) => {
      if (update.symbol === SYMBOL) setLatest(update)
    })
    window.api.market.subscribe(SYMBOL)

    return () => {
      unsubscribeListener()
      window.api.market.unsubscribe(SYMBOL)
    }
  }, [])

  return (
    <Card title="Price chart">
      <p style={{ opacity: 0.6 }}>Chart placeholder — wire up a real charting library here.</p>
      <p>
        {SYMBOL}: {latest ? `$${latest.price.toFixed(2)}` : 'subscribing...'}
      </p>
    </Card>
  )
}
