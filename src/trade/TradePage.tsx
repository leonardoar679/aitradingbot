import { useState } from 'react'
import { describeTicketProblem } from './orderTicket'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { MarketTicker } from '../dashboard/MarketTicker'
import { formatQuotePrice } from '../utils/formatCurrency'
import { useLastPrice } from '../hooks/useLastPrice'
import { EXCHANGES, type Exchange, type SymbolInfo } from '../../shared/ipc'
import { classifyPaperOrder, paperOrderStatusNote, type PaperOrderStatus } from './paperOrderStatus'
import { ExchangeCompareCard } from './ExchangeCompareCard'
import { useI18n } from '../i18n'

type Side = 'buy' | 'sell'
type OrderType = 'market' | 'limit'

interface PaperOrder {
  id: string
  time: number
  side: Side
  type: OrderType
  symbol: string
  quoteAsset: string
  amount: number
  price: number
  /** See classifyPaperOrder — 'filled', 'resting', or 'unpriced' when there was no live price to
   * judge against at submit time. */
  status: PaperOrderStatus
}

function sideButtonStyle(active: boolean, side: Side): React.CSSProperties {
  const color = side === 'buy' ? 'var(--up)' : 'var(--down)'
  return {
    flex: 1,
    padding: '0.55rem',
    fontSize: '0.85rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    border: `1px solid ${active ? color : 'var(--border)'}`,
    borderRadius: 'var(--radius-sm)',
    background: active ? color : 'transparent',
    color: active ? '#0b0e11' : 'var(--text-secondary)',
    cursor: 'pointer'
  }
}

function typeButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '0.4rem 0.8rem',
    fontSize: '0.78rem',
    fontWeight: 600,
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    background: active ? 'var(--bg-surface-hover)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    cursor: 'pointer'
  }
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-app)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '0.55rem 0.7rem',
  color: 'var(--text-primary)',
  fontSize: '0.85rem'
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.72rem',
  color: 'var(--text-muted)',
  marginBottom: '0.3rem'
}


/** `embedded` leaves the title to the page this sits on (Paper Trading). */
export function TradePage({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const i18n = useI18n()
  const { t, time } = i18n
  const [exchange, setExchange] = useState<Exchange>(EXCHANGES[0].id)
  const [pair, setPair] = useState<SymbolInfo>(EXCHANGES[0].defaultSymbol)
  const [side, setSide] = useState<Side>('buy')
  const [type, setType] = useState<OrderType>('market')
  const [amount, setAmount] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [orders, setOrders] = useState<PaperOrder[]>([])

  const lastPrice = useLastPrice(exchange, pair.symbol)

  function handleExchangeChange(next: Exchange): void {
    setExchange(next)
    const info = EXCHANGES.find((e) => e.id === next)
    if (info) setPair(info.defaultSymbol)
  }

  const amountNum = Number(amount)
  const execPrice = type === 'market' ? lastPrice : Number(limitPrice) || null
  const estValue = execPrice && amountNum > 0 && Number.isFinite(amountNum) ? execPrice * amountNum : null
  // A bare boolean left an unfillable ticket as a greyed-out button with no reason -- and let
  // Number('1e999') through as a positive amount. See describeTicketProblem.
  const ticketProblem = describeTicketProblem({ amountRaw: amount, type, limitPriceRaw: limitPrice, lastPrice }, i18n)
  const canSubmit = ticketProblem === null

  function handleSubmit(): void {
    if (!canSubmit || execPrice === null) return
    const status = classifyPaperOrder(type, side, execPrice, lastPrice)
    setOrders((prev) => [
      {
        id: crypto.randomUUID(),
        time: Date.now(),
        side,
        type,
        symbol: pair.symbol,
        quoteAsset: pair.quoteAsset,
        amount: amountNum,
        price: execPrice,
        status
      },
      ...prev
    ])
    setAmount('')
    setLimitPrice('')
  }

  return (
    <>
      {!embedded && <PageHeader title={t('Trade')} subtitle={t('Manual paper trading — orders are simulated, not sent to any exchange')} />}

      <MarketTicker exchange={exchange} pair={pair} onExchangeChange={handleExchangeChange} onPairChange={setPair} />

      <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 320px', minWidth: 280 }}>
          <Card title={t('Order ticket')}>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.9rem' }}>
              <button style={sideButtonStyle(side === 'buy', 'buy')} onClick={() => setSide('buy')}>
                {t('Buy')}
              </button>
              <button style={sideButtonStyle(side === 'sell', 'sell')} onClick={() => setSide('sell')}>
                {t('Sell')}
              </button>
            </div>

            <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.9rem' }}>
              <button style={typeButtonStyle(type === 'market')} onClick={() => setType('market')}>
                {t('Market@@an order at the price now')}
              </button>
              <button style={typeButtonStyle(type === 'limit')} onClick={() => setType('limit')}>
                {t('Limit@@an order at a set price')}
              </button>
            </div>

            {type === 'limit' && (
              <div style={{ marginBottom: '0.75rem' }}>
                <label style={labelStyle}>{t('Limit price ({asset})', { asset: pair.quoteAsset })}</label>
                <input
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  placeholder="0.00"
                  inputMode="decimal"
                  style={inputStyle}
                />
              </div>
            )}

            <div style={{ marginBottom: '0.9rem' }}>
              <label style={labelStyle}>{t('Amount ({asset})', { asset: pair.baseAsset })}</label>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                style={inputStyle}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', marginBottom: '1rem' }}>
              <span style={{ color: 'var(--text-muted)' }}>{t('Estimated value')}</span>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
                {estValue !== null ? formatQuotePrice(estValue, pair.quoteAsset) : '—'}
              </span>
            </div>

            {ticketProblem !== null && amount.trim() !== '' && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.74rem', margin: '0 0 0.6rem', lineHeight: 1.4 }}>
                {ticketProblem}
              </p>
            )}

            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              title={ticketProblem ?? undefined}
              style={{
                width: '100%',
                padding: '0.65rem',
                fontSize: '0.85rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                background: side === 'buy' ? 'var(--up)' : 'var(--down)',
                color: '#0b0e11',
                cursor: canSubmit ? 'pointer' : 'default',
                opacity: canSubmit ? 1 : 0.5
              }}
            >
              {side === 'buy' ? t('Buy {asset} on paper', { asset: pair.baseAsset }) : t('Sell {asset} on paper', { asset: pair.baseAsset })}
            </button>
          </Card>
        </div>

        <div style={{ flex: '1 1 400px', minWidth: 320 }}>
          <Card title={t('Session orders')}>
            {/* This warning used to live only in the empty state -- shown when there was nothing
                to lose, and hidden the moment there was. */}
            <p style={{ color: 'var(--text-muted)', fontSize: '0.74rem', margin: '0 0 0.7rem', lineHeight: 1.45 }}>
              {orders.length === 0
                ? t("No paper orders placed yet this session. Orders here aren't persisted or sent to your exchange.")
                : t("This list is cleared when you leave the page — it isn't saved, isn't sent to any exchange, and doesn't feed your Portfolio or Positions.")}
            </p>
            {orders.length === 0 ? null : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {orders.map((o) => (
                  <div
                    key={o.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.6rem 0.8rem',
                      background: 'var(--bg-app)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.8rem'
                    }}
                  >
                    <div>
                      <span
                        style={{
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: o.side === 'buy' ? 'var(--up)' : 'var(--down)',
                          marginInlineEnd: '0.5rem'
                        }}
                      >
                        {o.side === 'buy' ? t('Buy') : t('Sell')}
                      </span>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{o.symbol}</span>
                      <span style={{ color: 'var(--text-muted)', marginInlineStart: '0.5rem' }}>
                        {o.type === 'market' ? t('Market@@an order at the price now') : t('Limit@@an order at a set price')} • {time(o.time)}
                      </span>
                      {paperOrderStatusNote(o.status, i18n) !== null && (
                        <span style={{ color: 'var(--text-muted)', marginInlineStart: '0.5rem', fontStyle: 'italic' }}>
                          {paperOrderStatusNote(o.status, i18n)}
                        </span>
                      )}
                    </div>
                    <div style={{ textAlign: 'end' }}>
                      <div style={{ color: o.status === 'filled' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {o.amount} @ {formatQuotePrice(o.price, o.quoteAsset)}
                      </div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                        {formatQuotePrice(o.amount * o.price, o.quoteAsset)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <ExchangeCompareCard baseAsset={pair.baseAsset} quoteAsset={pair.quoteAsset} />
    </>
  )
}
