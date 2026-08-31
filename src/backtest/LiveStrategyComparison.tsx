import type { Exchange } from '../../shared/ipc'
import type { StrategyDefinition } from './strategies'
import { trendRegimeEnsemble } from './strategies/trendRegimeEnsemble'
import { shortTermChannel } from './strategies/shortTermChannel'
import { shortTermChannelRegime } from './strategies/shortTermChannelRegime'
import { describeNextAction, readLiveSignals } from './liveSignal'
import { useLiveBacktest } from './useLiveBacktest'

// All three shipped strategies on one symbol at once, each at the bar size it was measured on.
//
// WHY THE INTERVAL IS NOT THE PAGE'S. Trend Regime was measured at 4h and the two channel
// strategies at 15m (research/INTERVAL.md), and a comparison that forced all three onto whichever
// interval happened to be selected would not be comparing the three strategies -- it would be
// comparing three strategies at a bar size two of them were never validated on. Same symbol, same
// minute, BTCUSDT Trend Regime: long since 08-17 and +21.92% at 4h, long since 08-25 and -0.81% at
// 1h. Each row therefore uses its own preferredInterval and says so.
//
// WHAT THIS COSTS, MEASURED. An earlier version of this comment claimed the two 15m rows share a
// candleCache key and so cost one fetch between them. Sharing a key is true; costing one fetch is
// not, and the case it gets wrong is the one a user meets every time they open this tab.
//
// The rows mount together, so on a cold cache all three are in flight before any has stored
// anything, and all three miss. Opening the tab is three full fetches -- 620 bars at 4h, then 909
// and 7,820 at 15m, roughly ten paged requests. Sharing pays off only once warm, where the 15m
// pair does read one stored series and each poll is a one-bar tail.
//
// Left alone rather than serialised. Priming the wide window first would save those requests once
// per tab open, at the price of coordination between sibling rows -- the shared mutable await
// candleCache.ts declines for the same reason. Its header already records that the loser of this
// race pays a refetch and never a wrong answer; tests/candleCache.test.ts pins both halves.
//
// This exists because the honest advice about these strategies is to run exactly ONE of them --
// their monthly returns correlate 0.70 to 0.97, so holding two is one bet at 1.7x size, not
// diversification. A view showing all three side by side is for DECIDING between them, and for
// seeing that they mostly agree, which is the fact that makes running several a mistake.
const SHIPPED: StrategyDefinition[] = [trendRegimeEnsemble, shortTermChannel, shortTermChannelRegime]

const pc = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`

const cell: React.CSSProperties = { padding: '0.5rem 0.7rem', borderTop: '1px solid var(--border)' }
const num: React.CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

function Row({
  strategy,
  exchange,
  symbol,
  active,
  highlight
}: {
  strategy: StrategyDefinition
  exchange: Exchange
  symbol: string
  active: boolean
  highlight: boolean
}): React.JSX.Element {
  const state = useLiveBacktest(exchange, symbol, strategy.preferredInterval, strategy.id, active)
  const result = state.result
  const open = result?.openPositionAtEnd ?? null
  const inPosition = open !== null
  const last = state.candles.length ? state.candles[state.candles.length - 1] : null

  const readings = result ? readLiveSignals(state.candles, strategy.id) : []
  const action = result ? describeNextAction(readings, inPosition) : null
  const unrealized = open && last ? ((last.close - open.entryPrice) / open.entryPrice) * 100 : null

  // The short form of the action: what it is waiting on, not the whole sentence.
  const waiting = !result
    ? state.status === 'error'
      ? 'poll failed'
      : 'loading…'
    : state.warmingUp
      ? 'warming up'
      : action && action.blocking.length > 0
        ? action.blocking.map((b) => `${b.label.toLowerCase()} ${b.display}→${b.describe(b.enterAt)}`).join(', ')
        : inPosition
          ? 'holding'
          : 'entry conditions met'

  return (
    <tr style={highlight ? { background: 'var(--bg-app)' } : undefined}>
      <td style={cell}>
        {strategy.name}
        {highlight && <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}> · shown below</span>}
      </td>
      <td style={{ ...cell, color: 'var(--text-muted)' }}>{strategy.preferredInterval}</td>
      <td style={{ ...cell, color: inPosition ? 'var(--up)' : 'var(--text-secondary)' }}>
        {result ? (inPosition ? 'Long' : 'Flat') : '—'}
      </td>
      <td style={{ ...num, color: unrealized === null ? 'var(--text-muted)' : unrealized >= 0 ? 'var(--up)' : 'var(--down)' }}>
        {unrealized === null ? '—' : pc(unrealized)}
      </td>
      <td
        style={{
          ...num,
          color: !result ? 'var(--text-muted)' : result.stats.totalNetProfitPct >= 0 ? 'var(--up)' : 'var(--down)'
        }}
      >
        {result ? pc(result.stats.totalNetProfitPct) : '—'}
      </td>
      <td style={{ ...num, color: 'var(--text-secondary)' }}>{result ? result.stats.totalClosedTrades : '—'}</td>
      <td style={{ ...cell, color: 'var(--text-muted)', fontSize: '0.74rem' }}>{waiting}</td>
    </tr>
  )
}

export function LiveStrategyComparison({
  exchange,
  symbol,
  active,
  selectedStrategyId
}: {
  exchange: Exchange
  symbol: string
  active: boolean
  selectedStrategyId: string
}): React.JSX.Element {
  return (
    <div style={{ marginBottom: '1.75rem' }}>
      <div
        style={{
          fontSize: '0.72rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: '0.5rem'
        }}
      >
        All three shipped strategies on {symbol}, each at its own measured bar size
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)' }}>
              <th style={{ ...cell, textAlign: 'left', borderTop: 'none', fontWeight: 400 }}>Strategy</th>
              <th style={{ ...cell, textAlign: 'left', borderTop: 'none', fontWeight: 400 }}>Bar</th>
              <th style={{ ...cell, textAlign: 'left', borderTop: 'none', fontWeight: 400 }}>Position</th>
              <th style={{ ...num, borderTop: 'none', fontWeight: 400 }}>Unrealized</th>
              <th style={{ ...num, borderTop: 'none', fontWeight: 400 }}>Window P&L</th>
              <th style={{ ...num, borderTop: 'none', fontWeight: 400 }}>Trades</th>
              <th style={{ ...cell, textAlign: 'left', borderTop: 'none', fontWeight: 400 }}>Waiting on</th>
            </tr>
          </thead>
          <tbody>
            {SHIPPED.map((s) => (
              <Row
                key={s.id}
                strategy={s}
                exchange={exchange}
                symbol={symbol}
                active={active}
                highlight={s.id === selectedStrategyId}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.6rem 0 0' }}>
        Window P&amp;L is each strategy&apos;s own fetched window, which differs by bar size — it compares
        them to each other, not to a shared start date. These three correlate 0.70 to 0.97 month to
        month, so running two is one bet at 1.7× size rather than diversification; this table is for
        choosing between them.
      </p>
    </div>
  )
}
