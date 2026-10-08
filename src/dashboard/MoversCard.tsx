import { useState } from 'react'
import { Card } from '../components/Card'
import { MOVERS_SHOWN, emergingMovers, rankMovers, type EmergingMover, type MoverKind, type ResearchPair } from '../../shared/marketResearch'
import { describeEventType } from '../../shared/marketEvent'
import type { SymbolInfo } from '../../shared/ipc'
import { useMarketResearch } from '../hooks/useMarketResearch'
import { useScanner } from '../hooks/useScanner'

type Tab = MoverKind | 'emerging' | 'trending'

const TABS: { id: Tab; label: string }[] = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: 'volume', label: 'Volume' },
  { id: 'emerging', label: 'Emerging' },
  { id: 'trending', label: 'Trending' }
]

/** Rows listed in each column. */
const SHOWN = MOVERS_SHOWN

const pct = (value: number | null): React.JSX.Element =>
  value === null ? (
    <span style={{ color: 'var(--text-muted)' }}>—</span>
  ) : (
    <span style={{ color: value > 0 ? 'var(--up)' : value < 0 ? 'var(--down)' : undefined }}>{`${value > 0 ? '+' : ''}${value.toFixed(2)}%`}</span>
  )

const plainPct = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)}%`)

/** A score across the universe: zero is the middle, signed to a hundredth. */
const score = (value: number | null): React.JSX.Element =>
  value === null ? (
    <span style={{ color: 'var(--text-muted)' }}>—</span>
  ) : (
    <span style={{ fontWeight: 700, color: value > 0 ? 'var(--up)' : value < 0 ? 'var(--down)' : undefined }}>{`${value > 0 ? '+' : ''}${value.toFixed(2)}`}</span>
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
  { title: 'Range', cell: (pair) => plainPct(pair.range24hPct) },
  { title: 'From the high', cell: (pair) => pct(pair.fromHigh24hPct) },
  { title: 'Traded', cell: (pair) => millions(pair.quoteVolume24h) },
  { title: 'Score', cell: (pair) => score(pair.score24h) }
]

const WEEK_COLUMNS: Column[] = [
  { title: '7d', cell: (pair) => pct(pair.change7dPct) },
  { title: 'Up / strong days', cell: (pair) => (pair.upDays === null ? '—' : `${pair.upDays} / ${pair.strongDays ?? '—'} of 7`) },
  { title: 'Volatility', cell: (pair) => plainPct(pair.volatility7dPct) },
  { title: 'Trend', cell: (pair) => (pair.trend7d === null ? '—' : pair.trend7d.toFixed(2)) },
  { title: 'From the high', cell: (pair) => pct(pair.fromHigh7dPct) },
  { title: 'Score', cell: (pair) => score(pair.score7d) }
]

const VOLUME_COLUMNS: Column[] = [
  { title: 'Against its week', cell: (pair) => `${(pair.volumeExpansion ?? 0).toFixed(1)}×` },
  { title: '24h', cell: (pair) => pct(pair.change24hPct) },
  { title: 'Traded', cell: (pair) => millions(pair.quoteVolume24h) }
]

const bandWord = (mover: EmergingMover): string => (mover.type === null ? mover.band.toUpperCase() : `${describeEventType(mover.type).toUpperCase()} · ${mover.band.toUpperCase()}`)

/** What moved most among the liquid USDT pairs, from the research the app does as it opens
 * (shared/marketResearch.ts): over the day and over the week, each with its score across the
 * universe; by volume against its week; what is becoming interesting now, from the scanner's
 * reading of the minute set beside the day; and what CoinGecko says is trending. A pair's row
 * opens its chart above. Public data; nothing is asked. */
export function MoversCard({ onPick }: { onPick: (pair: SymbolInfo) => void }): React.JSX.Element {
  const { state } = useMarketResearch()
  const scanner = useScanner()
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

  const emerging = (): React.JSX.Element => {
    if (scanner === null || !scanner.config.enabled) {
      return <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>The scanner is off (Settings › Market), so there is no reading of the minute to set beside the day.</p>
    }
    const rows = emergingMovers(state?.pairs ?? [], scanner.pairs, SHOWN * 2)
    if (rows.length === 0) return <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>The scanner has not read the market yet.</p>
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="emerging-table">
          <thead>
            <tr>
              <th style={head}>Pair</th>
              <th style={head}>24h</th>
              <th style={head}>15m</th>
              <th style={head}>Volume</th>
              <th style={head}>Score</th>
              <th style={head}>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((mover) => (
              <tr
                key={mover.symbol}
                onClick={() => onPick({ symbol: mover.symbol, baseAsset: mover.symbol.replace(/USDT$/, ''), quoteAsset: 'USDT' })}
                style={{ cursor: 'pointer' }}
                title={`Open ${mover.symbol} above`}
              >
                <td style={{ ...cell, fontWeight: 700 }}>
                  {mover.symbol}
                  {mover.inDayTop && <span style={{ marginLeft: '0.35rem', fontSize: '0.66rem', color: 'var(--text-muted)' }}>DAY'S TOP</span>}
                </td>
                <td style={cell}>{pct(mover.change24hPct)}</td>
                <td style={cell}>{pct(mover.m15Pct)}</td>
                <td style={cell}>{mover.volumeRatio === null ? '—' : `${mover.volumeRatio.toFixed(1)}×`}</td>
                <td style={{ ...cell, fontWeight: 700 }}>{Math.round(mover.score)}</td>
                <td style={{ ...cell, color: mover.direction === 'up' ? 'var(--up)' : mover.direction === 'down' ? 'var(--down)' : 'var(--text-muted)' }}>{bandWord(mover)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          The scanner's score is the acceleration: a 15-minute move against its usual size, and five minutes' volume against the prior hundred, with the
          structure and the pressure behind them (shared/marketEvent.ts). A coin at +2% on the day and five times its volume now ranks above one at +15%
          going quiet; DAY'S TOP marks one already among the day's {SHOWN} biggest risers.
        </p>
      </div>
    )
  }

  let body: React.JSX.Element
  if (state === null || (state.pairs.length === 0 && state.running)) body = <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>Researching the market…</p>
  else if (tab === 'emerging') body = emerging()
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
      {state !== null && state.pairs.length > 0 && tab !== 'emerging' && (
        <p style={{ margin: '0.7rem 0 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          The {state.pairs.length} most traded USDT pairs over $20M a day, read as the app opened and every ten minutes; stablecoins are left out. A score
          is a pair's standing across them, zero in the middle: the day's from its move, its volume against its week, its range and its distance from the
          day's high; the week's from its move, its volatility, its trend, its distance from the week's high and its strong days. A row opens its chart
          above.
        </p>
      )}
    </Card>
  )
}
