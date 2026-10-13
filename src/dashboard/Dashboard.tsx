import { useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { MarketTicker } from './MarketTicker'
import { MoversCard } from './MoversCard'
import { WhyButton } from '../news/WhyItMovedHost'
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
      <PageHeader title="Market" subtitle="One pair on any supported exchange: live price, chart and indicators" />
      <MarketTicker
        exchange={exchange}
        pair={pair}
        onExchangeChange={handleExchangeChange}
        onPairChange={setPair}
      />
      {exchange === 'binance' && pair.quoteAsset === 'USDT' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          Why did {pair.symbol} move over the last hour, and what news named it? <WhyButton symbol={pair.symbol} />
        </div>
      )}
      <TradingChart exchange={exchange} symbol={pair.symbol} quoteAsset={pair.quoteAsset} />
      {/* What moved most among Binance's liquid USDT pairs; a row opens its chart above. */}
      <MoversCard
        onPick={(next) => {
          setExchange('binance')
          setPair(next)
        }}
      />
    </>
  )
}
