import { useEffect, useState } from 'react'
import { Coins, TrendingUp, TrendingDown } from 'lucide-react'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { formatAssetNumber, formatQuotePrice } from '../utils/formatCurrency'
import type { Exchange, SymbolInfo, Ticker24h } from '../../shared/ipc'

interface MarketTickerProps {
  exchange: Exchange
  pair: SymbolInfo
  onExchangeChange: (exchange: Exchange) => void
  onPairChange: (pair: SymbolInfo) => void
}

function coinIconUrl(baseAsset: string): string {
  return `https://assets.coincap.io/assets/icons/${baseAsset.toLowerCase()}@2x.png`
}

export function MarketTicker({
  exchange,
  pair,
  onExchangeChange,
  onPairChange
}: MarketTickerProps): React.JSX.Element {
  const [ticker, setTicker] = useState<Ticker24h | null>(null)
  const [iconFailed, setIconFailed] = useState(false)

  useEffect(() => {
    setIconFailed(false)
  }, [pair.baseAsset])

  useEffect(() => {
    setTicker(null)
    let cancelled = false
    let unsubscribeUpdates: (() => void) | null = null

    async function start(): Promise<void> {
      try {
        const snapshot = await window.api.market.subscribeTicker(exchange, pair.symbol)
        if (cancelled) return
        setTicker(snapshot)
        unsubscribeUpdates = window.api.market.onTickerUpdate(setTicker)
      } catch (error) {
        console.error('Failed to load ticker:', error)
      }
    }
    void start()

    return () => {
      cancelled = true
      unsubscribeUpdates?.()
      void window.api.market.unsubscribeTicker()
    }
  }, [exchange, pair.symbol])

  const positive = (ticker?.priceChangePercent ?? 0) >= 0
  const changeColor = positive ? 'var(--up)' : 'var(--down)'

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: '1.4rem',
        rowGap: '0.75rem',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '1rem 1.5rem'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          paddingRight: '1.4rem',
          borderRight: '1px solid var(--border)'
        }}
      >
        {iconFailed ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'rgba(240,185,11,0.15)',
              color: '#f0b90b',
              flexShrink: 0
            }}
          >
            <Coins size={18} />
          </div>
        ) : (
          <img
            src={coinIconUrl(pair.baseAsset)}
            alt={pair.baseAsset}
            onError={() => setIconFailed(true)}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              flexShrink: 0,
              objectFit: 'cover',
              background: 'rgba(240,185,11,0.15)'
            }}
          />
        )}
        <div>
          <SymbolSearch exchange={exchange} symbol={pair.symbol} onSelect={onPairChange} />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              marginTop: '0.15rem'
            }}
          >
            {pair.baseAsset} Price
            {positive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
          </div>
        </div>
      </div>

      <div style={{ paddingRight: '1.4rem', borderRight: '1px solid var(--border)' }}>
        <ExchangeSelect exchange={exchange} onSelect={onExchangeChange} />
      </div>

      <Stat value={ticker ? formatQuotePrice(ticker.lastPrice, pair.quoteAsset) : '—'} big divider />
      <Stat
        label="24h Chg"
        value={
          ticker
            ? `${formatAssetNumber(ticker.priceChange, pair.quoteAsset)} ${ticker.priceChangePercent >= 0 ? '+' : ''}${ticker.priceChangePercent.toFixed(2)}%`
            : '—'
        }
        color={changeColor}
        divider
      />
      <Stat
        label="24h High"
        value={ticker ? formatAssetNumber(ticker.highPrice, pair.quoteAsset) : '—'}
        divider
      />
      <Stat
        label="24h Low"
        value={ticker ? formatAssetNumber(ticker.lowPrice, pair.quoteAsset) : '—'}
        divider
      />
      <Stat
        label={`24h Vol(${pair.baseAsset})`}
        value={ticker ? formatAssetNumber(ticker.volume, pair.baseAsset) : '—'}
        divider
      />
      <Stat
        label={`24h Vol(${pair.quoteAsset})`}
        value={ticker ? formatAssetNumber(ticker.quoteVolume, pair.quoteAsset) : '—'}
      />
    </div>
  )
}

function Stat({
  label,
  value,
  color,
  big,
  divider
}: {
  label?: string
  value: string
  color?: string
  big?: boolean
  divider?: boolean
}): React.JSX.Element {
  return (
    <div
      style={{
        flexShrink: 0,
        paddingRight: divider ? '1.4rem' : 0,
        borderRight: divider ? '1px solid var(--border)' : 'none'
      }}
    >
      {label && (
        <div
          style={{
            fontSize: '0.7rem',
            color: 'var(--text-secondary)',
            marginBottom: '0.2rem',
            whiteSpace: 'nowrap'
          }}
        >
          {label}
        </div>
      )}
      <div
        style={{
          fontSize: big ? '1.3rem' : '0.85rem',
          fontWeight: big ? 700 : 600,
          color: color ?? 'var(--text-primary)',
          whiteSpace: 'nowrap'
        }}
      >
        {value}
      </div>
    </div>
  )
}
