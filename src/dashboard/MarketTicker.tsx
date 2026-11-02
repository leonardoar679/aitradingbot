import { useEffect, useState } from 'react'
import { Coins, TrendingUp, TrendingDown } from 'lucide-react'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { formatAssetNumber, formatQuotePrice } from '../utils/formatCurrency'
import { describeTickerProblem } from './tickerStatus'
import type { Exchange, SymbolInfo, Ticker24h } from '../../shared/ipc'
import { useI18n } from '../i18n'

/** How often the header re-reads the full 24h ticker over REST when the socket isn't feeding it. */
const REST_REFRESH_MS = 15_000

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
  const i18n = useI18n()
  const { t } = i18n
  const [ticker, setTicker] = useState<Ticker24h | null>(null)
  const [iconFailed, setIconFailed] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  useEffect(() => {
    setIconFailed(false)
  }, [pair.baseAsset])

  useEffect(() => {
    setTicker(null)
    setLastError(null)
    let cancelled = false
    let unsubscribeUpdates: (() => void) | null = null
    let lastTickAt = 0

    // The socket is one global stream that any other subscriber can tear out from under this
    // header, and the initial subscribe can fail outright (a geo-blocked or unreachable
    // endpoint). Either way the row used to sit on em dashes or a frozen price forever, while
    // the chart below -- a separate candle stream -- kept ticking the same symbol. This poll
    // is what makes the header recover on its own, the same fix useLastPrice carries.
    async function refreshFromRest(): Promise<void> {
      if (Date.now() - lastTickAt < REST_REFRESH_MS) return
      try {
        const snapshot = await window.api.market.fetchTicker24h(exchange, pair.symbol)
        if (cancelled) return
        setTicker(snapshot)
        setLastError(null)
      } catch (error) {
        if (cancelled) return
        // Only surfaced while there is nothing to show at all; once a price has arrived, the
        // last known figures stay up rather than blanking on a single failed refresh.
        setLastError(error instanceof Error ? error.message : String(error))
      }
    }

    async function start(): Promise<void> {
      try {
        const snapshot = await window.api.market.subscribeTicker(exchange, pair.symbol)
        if (cancelled) return
        setTicker(snapshot)
        lastTickAt = Date.now()
        // Ticker updates are broadcast with no symbol attached to the listener, and
        // marketService keeps one global stream, so a second subscriber on another symbol would
        // feed its prices straight into this header.
        unsubscribeUpdates = window.api.market.onTickerUpdate((t) => {
          if (t.symbol !== pair.symbol) return
          lastTickAt = Date.now()
          setTicker(t)
          setLastError(null)
        })
      } catch (error) {
        if (cancelled) return
        setLastError(error instanceof Error ? error.message : String(error))
        // The REST poll below still fills this row in, so a failed subscribe is no longer fatal.
        void refreshFromRest()
      }
    }
    void start()
    const timer = setInterval(() => void refreshFromRest(), REST_REFRESH_MS)

    return (): void => {
      cancelled = true
      clearInterval(timer)
      unsubscribeUpdates?.()
      void window.api.market.unsubscribeTicker()
    }
  }, [exchange, pair.symbol])

  // Null means no data, not "up". The old default painted a green up-arrow and a green dash
  // over a row that had failed to load anything.
  const direction = ticker === null ? null : ticker.priceChangePercent >= 0
  const changeColor = direction === null ? 'var(--text-muted)' : direction ? 'var(--up)' : 'var(--down)'
  const problem = describeTickerProblem(
    {
      hasTicker: ticker !== null,
      lastError,
      symbol: pair.symbol
    },
    i18n
  )

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
          paddingInlineEnd: '1.4rem',
          borderInlineEnd: '1px solid var(--border)'
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
            {t('{asset} price', { asset: pair.baseAsset })}
            {direction === null ? null : direction ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
          </div>
        </div>
      </div>

      <div style={{ paddingInlineEnd: '1.4rem', borderInlineEnd: '1px solid var(--border)' }}>
        <ExchangeSelect exchange={exchange} onSelect={onExchangeChange} />
      </div>

      <Stat value={ticker ? formatQuotePrice(ticker.lastPrice, pair.quoteAsset) : '—'} big divider />
      <Stat
        label={t('24h change')}
        value={
          ticker
            ? `${formatQuotePrice(ticker.priceChange, pair.quoteAsset)} ${ticker.priceChangePercent >= 0 ? '+' : ''}${ticker.priceChangePercent.toFixed(2)}%`
            : '—'
        }
        color={changeColor}
        divider
      />
      <Stat
        label={t('24h high')}
        value={ticker ? formatQuotePrice(ticker.highPrice, pair.quoteAsset) : '—'}
        divider
      />
      <Stat
        label={t('24h low')}
        value={ticker ? formatQuotePrice(ticker.lowPrice, pair.quoteAsset) : '—'}
        divider
      />
      <Stat
        label={t('24h volume ({asset})', { asset: pair.baseAsset })}
        value={ticker ? formatAssetNumber(ticker.volume, pair.baseAsset) : '—'}
        divider
      />
      <Stat
        label={t('24h volume ({asset})', { asset: pair.quoteAsset })}
        value={ticker ? formatAssetNumber(ticker.quoteVolume, pair.quoteAsset) : '—'}
      />
      {problem && (
        <div
          style={{
            width: '100%',
            fontSize: '0.75rem',
            lineHeight: 1.45,
            color: 'var(--down)',
            background: 'var(--bg-app)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.5rem 0.7rem'
          }}
        >
          {problem}
        </div>
      )}
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
        paddingInlineEnd: divider ? '1.4rem' : 0,
        borderInlineEnd: divider ? '1px solid var(--border)' : 'none'
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
