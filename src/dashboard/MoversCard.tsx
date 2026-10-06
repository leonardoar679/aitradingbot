import { useState } from 'react'
import { Card } from '../components/Card'
import { rankMovers, type MoverKind, type ResearchPair } from '../../shared/marketResearch'
import type { SymbolInfo } from '../../shared/ipc'
import { useMarketResearch } from '../hooks/useMarketResearch'

type Tab = MoverKind | 'trending'

const TABS: { id: Tab; label: string }[] = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: 'volume', label: 'Volume' },
  { id: 'trending', label: 'Trending' }
]

/** Rows listed in each column. */
const SHOWN = 8

const pct = (value: number | null): React.JSX.Element =>
  value === null ? (
    <span style={{ color: 'var(--text-muted)' }}>—</span>
  ) : (
    <span style={{ color: value > 0 ? 'var(--up)' : value < 0 ? 'var(--down)' : undefined }}>{`${value > 0 ? '+' : ''}${value.toFixed(2)}%`}</span>
  )

const price = (value: number): string => Number(value.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 8 })
const millions = (value: number): string => `$${(value / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 0 })}M`

const cell: React.CSSProperties = { padding: '0.35rem 0.5rem', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
const head: React.CSSProperties = { ...cell, fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textAlign: 'left' }

interface Column {
  title: string
  cell: (pair: ResearchPair) => React.ReactNode
}

const DAY_COLUMNS: Column[] = [
  { title: '24h', cell: (pair) => pct(pair.change24hPct) },
  { title: 'Price', cell: (pair) => price(pair.price) },
  { title: 'Traded', cell: (pair) => millions(pair.quoteVolume24h) }
]

const WEEK_COLUMNS: Column[] = [
  { title: '7d', cell: (pair) => pct(pair.change7dPct) },
  { title: 'Days up', cell: (pair) => (pair.upDays === null ? '—' : `${pair.upDays} of 7`) },
  { title: 'From the high', cell: (pair) => pct(pair.fromHigh7dPct) }
]

const VOLUME_COLUMNS: Column[] = [
  { title: 'Against its week', cell: (pair) => `${(pair.volumeExpansion ?? 0).toFixed(1)}×` },
  { title: '24h', cell: (pair) => pct(pair.change24hPct) },
  { title: 'Traded', cell: (pair) => millions(pair.quoteVolume24h) }
]

/** What moved most among the liquid USDT pairs, from the research the app does as it opens
 * (shared/marketResearch.ts): over the day, over the week, by volume against its week, and what
 * CoinGecko says is trending. A pair's row opens its chart above. Public data; nothing is asked. */
export function MoversCard({ onPick }: { onPick: (pair: SymbolInfo) => void }): React.JSX.Element {
  const { state } = useMarketResearch()
  const [tab, setTab] = useState<Tab>('24h')

  const pick = (pair: ResearchPair): void => onPick({ symbol: pair.symbol, baseAsset: pair.baseAsset, quoteAsset: 'USDT' })

  const table = (rows: ResearchPair[], heading: string, columns: Column[]): React.JSX.Element => (
    <div style={{ flex: '1 1 320px', minWidth: 0, overflowX: 'auto' }}>
      <div style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-secondary)', margin: '0 0 0.3rem' }}>{heading}</div>
      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>None.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={head}>Pair</th>
              {columns.map((column) => (
                <th key={column.title} style={head}>
                  {column.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((pair) => (
              <tr key={pair.symbol} onClick={() => pick(pair)} style={{ cursor: 'pointer' }} title={`Open ${pair.symbol} above`}>
                <td style={{ ...cell, fontWeight: 700 }}>
                  {pair.symbol}
                  {pair.trending && <span style={{ marginLeft: '0.35rem', fontSize: '0.66rem', color: 'var(--gold)' }}>TRENDING</span>}
                </td>
                {columns.map((column) => (
                  <td key={column.title} style={cell}>
                    {column.cell(pair)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )

  let body: React.JSX.Element
  if (state === null || (state.pairs.length === 0 && state.running)) body = <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>Researching the market…</p>
  else if (state.pairs.length === 0) body = <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>The market could not be read yet.</p>
  else if (tab === 'trending') {
    const coins = state.trending
    body =
      coins === null ? (
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {state.steps.find((step) => step.id === 'trending')?.detail ?? "CoinGecko's trending list has not been read yet."}
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={head}>Coin</th>
              <th style={head}>Name</th>
              <th style={head}>Market-cap rank</th>
              <th style={head}>On Binance</th>
            </tr>
          </thead>
          <tbody>
            {coins.map((coin) => {
              const pair = coin.pair === null ? undefined : state.pairs.find((entry) => entry.symbol === coin.pair)
              return (
                <tr
                  key={`${coin.symbol}-${coin.name}`}
                  onClick={coin.pair === null ? undefined : (): void => onPick({ symbol: coin.pair as string, baseAsset: coin.symbol, quoteAsset: 'USDT' })}
                  style={{ cursor: coin.pair === null ? 'default' : 'pointer' }}
                >
                  <td style={{ ...cell, fontWeight: 700 }}>{coin.symbol}</td>
                  <td style={cell}>{coin.name}</td>
                  <td style={cell}>{coin.marketCapRank ?? '—'}</td>
                  <td style={cell}>
                    {coin.pair === null ? (
                      <span style={{ color: 'var(--text-muted)' }}>no USDT pair</span>
                    ) : (
                      <>
                        {coin.pair}
                        {pair !== undefined && <> · {pct(pair.change24hPct)} 24h</>}
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )
  } else if (tab === 'volume') {
    const { up } = rankMovers(state.pairs, 'volume', SHOWN * 2)
    body = (
      <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
        {table(up, "The day's volume against its week", VOLUME_COLUMNS)}
      </div>
    )
  } else {
    const { up, down } = rankMovers(state.pairs, tab, SHOWN)
    const columns = tab === '24h' ? DAY_COLUMNS : WEEK_COLUMNS
    body = (
      <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
        {table(up, tab === '24h' ? 'Rose most over the day' : 'Rose most over the week', columns)}
        {table(down, tab === '24h' ? 'Fell most over the day' : 'Fell most over the week', columns)}
      </div>
    )
  }

  return (
    <Card
      title="Movers"
      actions={
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              style={{
                background: tab === entry.id ? 'var(--accent-soft)' : 'none',
                border: `1px solid ${tab === entry.id ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                padding: '0.2rem 0.6rem',
                fontSize: '0.74rem',
                fontWeight: 600,
                color: tab === entry.id ? 'var(--accent)' : 'var(--text-primary)',
                cursor: 'pointer'
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      }
    >
      {body}
      {state !== null && state.pairs.length > 0 && (
        <p style={{ margin: '0.7rem 0 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          The {state.pairs.length} most traded USDT pairs over $20M a day, read as the app opened and every ten minutes; stablecoins are left out. A row opens its
          chart above.
        </p>
      )}
    </Card>
  )
}
