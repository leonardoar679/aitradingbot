import { useEffect, useState } from 'react'
import type { Interval } from '../../shared/ipc'
import { getStrategy } from './strategies'
import { formatUtcShort, formatHoldingDuration } from './formatTradeTime'
import { describeNextAction, readLiveSignals, type SignalReading } from './liveSignal'
import type { LiveBacktestState } from './useLiveBacktest'

// The live panel. Everything on it is derived from the same engine run and the strategies' own
// exported readings -- see liveSignal.ts for why none of the thresholds are typed in here.

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`
}

/** Re-render on a timer so "updated 12s ago" is not frozen at whatever it said when the last poll
 * landed. Purely cosmetic, and deliberately separate from the poll itself. */
function useTick(everyMs: number): void {
  const [, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
}

function Gauge({ reading, inPosition }: { reading: SignalReading; inPosition: boolean }): React.JSX.Element {
  const v = Number.isFinite(reading.value) ? reading.value : 0
  const known = Number.isFinite(reading.value)
  // The bar is the 0..1 range the reading lives on, with both thresholds marked. Showing the
  // entry line and the exit line at once is the point: the gap between them IS the hysteresis
  // band, and it is why the strategy does not act on every wobble.
  const met = inPosition ? v > reading.exitAt : v >= reading.enterAt
  return (
    <div style={{ marginBottom: '1.1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.35rem' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{reading.label}</span>
        <span
          style={{
            fontSize: '0.95rem',
            fontVariantNumeric: 'tabular-nums',
            color: known ? (met ? 'var(--up)' : 'var(--text-primary)') : 'var(--text-muted)'
          }}
        >
          {reading.display}
        </span>
      </div>

      <div
        style={{
          position: 'relative',
          height: '0.6rem',
          background: 'var(--bg-app)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            width: `${Math.min(100, Math.max(0, v * 100))}%`,
            height: '100%',
            background: known ? (met ? 'var(--up)' : 'var(--text-muted)') : 'transparent',
            transition: 'width 0.3s ease'
          }}
        />
        <Marker at={reading.exitAt} title={`Exit at or below ${reading.describe(reading.exitAt)}`} />
        <Marker at={reading.enterAt} title={`Enter at ${reading.describe(reading.enterAt)}`} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.3rem' }}>
        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
          exit ≤ {reading.describe(reading.exitAt)}
        </span>
        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
          enter {reading.describe(reading.enterAt)}
        </span>
      </div>

      <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.4rem 0 0' }}>
        {reading.note}
        {!reading.gatesExit && ' Gates entries only — exits are not blocked by it.'}
      </p>
    </div>
  )
}

function Marker({ at, title }: { at: number; title: string }): React.JSX.Element {
  return (
    <div
      title={title}
      style={{
        position: 'absolute',
        left: `${at * 100}%`,
        top: 0,
        bottom: 0,
        width: '2px',
        background: 'var(--text-primary)',
        opacity: 0.55,
        transform: 'translateX(-1px)'
      }}
    />
  )
}

function Figure({ label, value, color }: { label: string; value: string; color?: string }): React.JSX.Element {
  return (
    <div style={{ minWidth: '7rem' }}>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.05rem', fontVariantNumeric: 'tabular-nums', color: color ?? 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  )
}

const pc = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
const money = (v: number): string => `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`

export function LiveBacktestView({
  state,
  strategyId,
  symbol,
  interval
}: {
  state: LiveBacktestState
  strategyId: string
  symbol: string
  interval: Interval
}): React.JSX.Element {
  useTick(1000)

  if (state.status === 'unsupported') {
    return <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{state.error}</p>
  }
  if (state.status === 'idle') {
    return <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Choose a symbol and strategy on Configuration to start monitoring.</p>
  }
  if (state.status === 'loading' && !state.result) {
    return <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Fetching candles and warming up the strategy…</p>
  }
  if (!state.result) {
    return <p style={{ color: 'var(--down)', margin: 0 }}>Error: {state.error}</p>
  }

  const { result, candles } = state
  const open = result.openPositionAtEnd
  const inPosition = open !== null
  const readings = readLiveSignals(candles, strategyId)
  const next = describeNextAction(readings, inPosition)
  const last = candles[candles.length - 1]
  const strategy = getStrategy(strategyId)
  const intervalMismatch = strategy.preferredInterval !== interval

  const unrealizedPct = open ? ((last.close - open.entryPrice) / open.entryPrice) * 100 : 0

  return (
    <div>
      {/* Status line. The stale-data case matters more than it looks: a poll that has been failing
          for ten minutes still shows the last good reading, and without this the panel would look
          live while quietly describing a market that has moved on. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          flexWrap: 'wrap',
          paddingBottom: '0.9rem',
          marginBottom: '1.1rem',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <span
          style={{
            width: '0.5rem',
            height: '0.5rem',
            borderRadius: '50%',
            background: state.status === 'error' ? 'var(--down)' : 'var(--up)'
          }}
        />
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {symbol} · {interval} · {strategy.name}
        </span>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {state.updatedAt ? `updated ${ago(state.updatedAt)}` : 'never updated'} · re-checks every 60s while this tab is open
        </span>
        {state.status === 'error' && (
          <span style={{ fontSize: '0.75rem', color: 'var(--down)' }}>last poll failed: {state.error}</span>
        )}
      </div>

      {intervalMismatch && (
        <p
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-secondary)',
            background: 'var(--bg-app)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.6rem 0.75rem',
            margin: '0 0 1.1rem'
          }}
        >
          Monitoring at <strong>{interval}</strong>, but {strategy.name} was measured on{' '}
          <strong>{strategy.preferredInterval}</strong>. Its lookbacks are defined in days, so it still
          means the same thing here — it is simply re-checked more or less often than the version the
          published results describe, and crosses its own hysteresis band a different number of times.
        </p>
      )}

      {state.warmingUp ? (
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Still warming up: {candles.length} candles fetched, {state.warmupBars} needed before this
          strategy can take a position. Nothing is wrong — this is the strategy&apos;s declared warm-up.
        </p>
      ) : (
        <>
          {/* What it is doing now */}
          <div style={{ display: 'flex', gap: '1.75rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
            <Figure
              label="Position"
              value={inPosition ? 'Long' : 'Flat (cash)'}
              color={inPosition ? 'var(--up)' : 'var(--text-secondary)'}
            />
            {open && (
              <>
                <Figure label="Entered" value={formatUtcShort(open.entryTime)} />
                <Figure label="Held for" value={formatHoldingDuration(last.time - open.entryTime)} />
                <Figure
                  label="Unrealized"
                  value={pc(unrealizedPct)}
                  color={unrealizedPct >= 0 ? 'var(--up)' : 'var(--down)'}
                />
              </>
            )}
            <Figure label="Last close" value={last.close.toLocaleString('en-US')} />
            <Figure label="Closed trades" value={String(result.stats.totalClosedTrades)} />
            <Figure
              label="Window P&L"
              value={pc(result.stats.totalNetProfitPct)}
              color={result.stats.totalNetProfitPct >= 0 ? 'var(--up)' : 'var(--down)'}
            />
          </div>

          {/* The reason this screen exists: what has to change for anything to happen. */}
          <p
            style={{
              fontSize: '0.9rem',
              color: 'var(--text-primary)',
              background: 'var(--bg-app)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.8rem 0.9rem',
              margin: '0 0 1.4rem'
            }}
          >
            {next.summary}
          </p>

          {readings.length > 0 && (
            <>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.8rem' }}>
                What the strategy is reading
              </div>
              {readings.map((r) => (
                <Gauge key={r.id} reading={r} inPosition={inPosition} />
              ))}
            </>
          )}

          {/* Recent closed trades, newest first. Bounded, because this is a monitor and not the
              results page -- the full list already has a home. */}
          {result.trades.length > 0 && (
            <>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '1.6rem 0 0.6rem' }}>
                Recent closed trades in this window
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                      <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem', fontWeight: 400 }}>Entered</th>
                      <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem', fontWeight: 400 }}>Exited</th>
                      <th style={{ padding: '0.4rem 0.6rem', fontWeight: 400 }}>Held</th>
                      <th style={{ padding: '0.4rem 0.6rem', fontWeight: 400 }}>Return</th>
                      <th style={{ padding: '0.4rem 0.6rem', fontWeight: 400 }}>P&L</th>
                      <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem', fontWeight: 400 }}>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...result.trades]
                      .slice(-8)
                      .reverse()
                      .map((t) => (
                        <tr key={`${t.entryTime}-${t.exitTime}`} style={{ borderTop: '1px solid var(--border)', textAlign: 'right' }}>
                          <td style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>{formatUtcShort(t.entryTime)}</td>
                          <td style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>{formatUtcShort(t.exitTime)}</td>
                          <td style={{ padding: '0.4rem 0.6rem' }}>{formatHoldingDuration(t.exitTime - t.entryTime)}</td>
                          <td style={{ padding: '0.4rem 0.6rem', color: t.returnPct >= 0 ? 'var(--up)' : 'var(--down)' }}>
                            {pc(t.returnPct)}
                          </td>
                          <td style={{ padding: '0.4rem 0.6rem', color: t.pnl >= 0 ? 'var(--up)' : 'var(--down)' }}>
                            {money(t.pnl)}
                          </td>
                          <td style={{ textAlign: 'left', padding: '0.4rem 0.6rem', color: 'var(--text-muted)' }}>
                            {t.exitReason.replace(/_/g, ' ')}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '1.4rem 0 0' }}>
            Simulated on {candles.length.toLocaleString('en-US')} candles ending{' '}
            {formatUtcShort(last.time)} UTC, starting from ${result.stats.startingBalance.toLocaleString('en-US')}. This
            is the same engine and the same strategy the Configuration tab backtests — it places no
            orders and holds no money.
          </p>
        </>
      )}
    </div>
  )
}
