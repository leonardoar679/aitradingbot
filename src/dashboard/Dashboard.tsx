import { useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { MarketTicker } from './MarketTicker'
import { TradingChart } from '../charts/TradingChart'
import { EXCHANGES, type Exchange, type SymbolInfo } from '../../shared/ipc'

export function Dashboard(): React.JSX.Element {
  const [exchange, setExchange] = useState<Exchange>(EXCHANGES[0].id)
  const [pair, setPair] = useState<SymbolInfo>(EXCHANGES[0].defaultSymbol)

  function handleExchangeChange(next: Exchange): void {
    setExchange(next)
    const info = EXCHANGES.find((e) => e.id === next)
    if (info) setPair(info.defaultSymbol)
  }

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Live market overview and account status" />
      <MarketTicker
        exchange={exchange}
        pair={pair}
        onExchangeChange={handleExchangeChange}
        onPairChange={setPair}
      />
      <TradingChart exchange={exchange} symbol={pair.symbol} quoteAsset={pair.quoteAsset} />
    </>
  )
}
