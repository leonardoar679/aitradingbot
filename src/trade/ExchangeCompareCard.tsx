import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { EXCHANGES, type MarketComparison, type ExchangeQuote } from '../../shared/ipc'
import { commonSymbol, DEPTH_BAND } from '../../shared/marketCompare'
import { describeError } from '../utils/ipcError'
import { useI18n } from '../i18n'

// BINANCE AGAINST BITGET (V7.1 Stage 6, 16 October 2026): the shown pair's price, spread, depth and
// freshness on the two exchanges, read at the same moment from their public market data when the
// pair changes and on REFRESH. Read-only: it places nothing and chooses no exchange for anyone.

const money = (value: number | null, digits = 2): string => (value === null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }))
const price = (value: number | null): string => (value === null || !Number.isFinite(value) ? '—' : value >= 100 ? money(value, 2) : value.toPrecision(5))
const nameOf = (quote: ExchangeQuote): string => EXCHANGES.find((entry) => entry.id === quote.exchange)?.name ?? quote.exchange

export function ExchangeCompareCard({ baseAsset, quoteAsset }: { baseAsset: string; quoteAsset: string }): React.JSX.Element {
  const { t, utcTime } = useI18n()
  const symbol = commonSymbol(baseAsset, quoteAsset)
  const [comparison, setComparison] = useState<MarketComparison | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const read = (): void => {
    setBusy(true)
    setProblem(null)
    window.api.market
      .compare(symbol)
      .then(setComparison, (failure: unknown) => setProblem(describeError(failure)))
      .finally(() => setBusy(false))
  }
  useEffect(read, [symbol])

  const band = `${(DEPTH_BAND * 100).toFixed(1)}%`
  const rows: { label: string; cell: (quote: ExchangeQuote) => string }[] = [
    { label: t('Last price ({asset})', { asset: quoteAsset }), cell: (quote) => price(quote.price) },
    { label: t('Best bid'), cell: (quote) => price(quote.bid) },
    { label: t('Best ask'), cell: (quote) => price(quote.ask) },
    { label: t('Spread'), cell: (quote) => (quote.spreadPct === null ? '—' : `${quote.spreadPct.toFixed(3)}%`) },
    { label: t('Bids within {band} ({asset})', { band, asset: quoteAsset }), cell: (quote) => money(quote.bidDepthQuote, 0) },
    { label: t('Asks within {band} ({asset})', { band, asset: quoteAsset }), cell: (quote) => money(quote.askDepthQuote, 0) },
    { label: t('24h volume ({asset})', { asset: quoteAsset }), cell: (quote) => money(quote.quoteVolume24h, 0) },
    { label: t("Book's age"), cell: (quote) => (quote.bookAgeMs === null ? t('not stamped') : t('{seconds} s', { seconds: (quote.bookAgeMs / 1000).toFixed(1) })) },
    { label: t('Read in'), cell: (quote) => (quote.roundTripMs === null ? '—' : t('{ms} ms', { ms: String(quote.roundTripMs) })) }
  ]

  return (
    <Card
      title={t('Binance vs Bitget')}
      actions={
        <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={read}>
          {busy ? t('Reading…') : t('Refresh')}
        </button>
      }
    >
      <p style={{ ...noteStyle, marginTop: 0 }}>
        {t('{symbol} on both exchanges, read at the same moment from their public market data. Depth is what rests within {band} of the mid, in {asset}. A comparison, not a recommendation: nothing here places an order.', { symbol, band, asset: quoteAsset })}
      </p>
      {comparison !== null && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>{t('{time} UTC', { time: utcTime(comparison.at) })}</th>
                {comparison.quotes.map((quote) => (
                  <th key={quote.exchange} style={headCellStyle}>
                    {nameOf(quote)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <td style={cellStyle}>{row.label}</td>
                  {comparison.quotes.map((quote) => (
                    <td key={quote.exchange} style={cellStyle}>
                      {row.cell(quote)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {comparison.quotes
            .filter((quote) => quote.problem !== null)
            .map((quote) => (
              <p key={quote.exchange} style={noteStyle}>
                {nameOf(quote)}: <bdi lang="en">{quote.problem}</bdi>
              </p>
            ))}
        </div>
      )}
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
    </Card>
  )
}
