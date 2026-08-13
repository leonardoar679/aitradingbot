import { EXCHANGES, type Exchange, type SymbolInfo, type SpreadMarket } from '../../shared/ipc'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { fieldLabelStyle } from './formStyles'

export function SpreadMarketPicker({
  label,
  market,
  onChange
}: {
  label: string
  market: SpreadMarket
  onChange: (market: SpreadMarket) => void
}): React.JSX.Element {
  function handleExchangeChange(exchange: Exchange): void {
    const info = EXCHANGES.find((e) => e.id === exchange)
    if (!info) return
    onChange({ exchange, symbol: info.defaultSymbol.symbol, baseAsset: info.defaultSymbol.baseAsset, quoteAsset: info.defaultSymbol.quoteAsset })
  }

  function handleSymbolChange(pair: SymbolInfo): void {
    onChange({ ...market, symbol: pair.symbol, baseAsset: pair.baseAsset, quoteAsset: pair.quoteAsset })
  }

  return (
    <div>
      <label style={fieldLabelStyle()}>{label}</label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <ExchangeSelect exchange={market.exchange} onSelect={handleExchangeChange} />
        <SymbolSearch exchange={market.exchange} symbol={market.symbol} onSelect={handleSymbolChange} />
      </div>
    </div>
  )
}
