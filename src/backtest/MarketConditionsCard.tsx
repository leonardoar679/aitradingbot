import { useEffect, useState } from 'react'
import type { Exchange } from '../../shared/ipc'
import { Card } from '../components/Card'
import { fetchRangeCached } from '../bots/candleCache'
import { ADX_QUIET, readMarketConditions, type MarketConditions } from './marketConditions'

// The pre-flight panel: what the market looked like before you commit a month to a strategy.
//
// Reads DAILY bars regardless of the interval selected for the backtest, because that is what the
// finding was measured on (research/ADX.md). 150 days is comfortably more than ADX(14) needs and is
// one paged request, so it costs nothing to keep the window generous.
//
// It never tells the user what to do. It reports a number, what that number has historically meant,
// and the two caveats that stop it being over-read -- that the win rate does NOT improve, and that
// one earlier test contradicted the finding. A panel that said "do not trade" would be claiming a
// confidence the evidence does not support.

const LOOKBACK_DAYS = 150
const DAY = 86_400

export function MarketConditionsCard({
  exchange,
  symbol,
  strategyId
}: {
  exchange: Exchange
  symbol: string
  strategyId: string
}): React.JSX.Element | null {
  const [state, setState] = useState<{ conditions: MarketConditions | null; error: string | null; loading: boolean }>({
    conditions: null,
    error: null,
    loading: true
  })

  useEffect(() => {
    if (symbol === '') return
    let cancelled = false
    setState({ conditions: null, error: null, loading: true })

    void (async () => {
      try {
        const endSec = Math.floor(Date.now() / 1000)
        const candles = await fetchRangeCached(
          (ex, sym, iv, from, to) => window.api.market.fetchHistoricalRange(ex, sym, iv, from, to),
          exchange,
          symbol,
          '1d',
          endSec - LOOKBACK_DAYS * DAY,
          endSec
        )
        if (cancelled) return
        setState({ conditions: readMarketConditions(candles, strategyId), error: null, loading: false })
      } catch (error) {
        if (cancelled) return
        setState({ conditions: null, error: error instanceof Error ? error.message : String(error), loading: false })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [exchange, symbol, strategyId])

  // Strategies with no measured expectation (EMA, RSI, Bollinger, GPT) get no panel rather than a
  // panel with an empty half: the finding was only ever measured on the three trend strategies.
  if (state.conditions !== null && state.conditions.expectation === null) return null

  const tone =
    state.conditions?.posture === 'quiet'
      ? 'var(--positive)'
      : state.conditions?.posture === 'trending'
        ? 'var(--down)'
        : 'var(--text-secondary)'

  const label =
    state.conditions?.posture === 'quiet'
      ? 'Quiet base'
      : state.conditions?.posture === 'trending'
        ? 'Trend already underway'
        : state.conditions?.posture === 'middling'
          ? 'In between'
          : 'Unreadable'

  return (
    <Card title="Market conditions before you commit">
      {state.loading && <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0 }}>Reading daily candles…</p>}

      {state.error !== null && (
        <p style={{ color: 'var(--down)', fontSize: '0.8rem', margin: 0 }}>
          Could not read daily candles for {symbol} ({state.error}).
        </p>
      )}

      {state.conditions !== null && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '1.6rem', fontWeight: 700, color: tone, fontVariantNumeric: 'tabular-nums' }}>
              {Number.isFinite(state.conditions.adx) ? state.conditions.adx.toFixed(1) : '—'}
            </span>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              ADX(14), daily · threshold {ADX_QUIET}
            </span>
            <span
              style={{
                marginLeft: 'auto',
                color: tone,
                border: `1px solid ${tone}`,
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.72rem',
                fontWeight: 600,
                padding: '0.15rem 0.5rem'
              }}
            >
              {label}
            </span>
          </div>

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, margin: '0.7rem 0 0' }}>
            {state.conditions.summary}
          </p>

          {state.conditions.expectation !== null && Number.isFinite(state.conditions.adx) && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, margin: '0.6rem 0 0' }}>
              Measured on six symbols this rule was never fitted to, 2019–2026: a month opening below{' '}
              {ADX_QUIET} averaged{' '}
              <strong style={{ color: 'var(--text-primary)' }}>
                {state.conditions.expectation.quietMeanPct.toFixed(1)}%
              </strong>{' '}
              for this strategy, against{' '}
              <strong style={{ color: 'var(--text-primary)' }}>
                {state.conditions.expectation.baselineMeanPct.toFixed(1)}%
              </strong>{' '}
              for a month picked at random.
            </p>
          )}

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', lineHeight: 1.5, margin: '0.6rem 0 0', opacity: 0.85 }}>
            Two things this does not say. It is not a direction forecast — these strategies lose money
            in nearly every falling month whatever the ADX, and the <em>win rate</em> under this rule is
            slightly lower, not higher; what improves is the size of the outcome. And one earlier test,
            on four symbols in 2023–26, contradicted the finding outright. Read it as one input, not a
            verdict.
          </p>
        </>
      )}
    </Card>
  )
}
