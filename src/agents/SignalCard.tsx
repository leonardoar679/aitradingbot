import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { INTERVAL_SECONDS, type Interval } from '../../shared/ipc'
import type { AiSignalDecision } from '../../shared/aiSignal'
import { formatUsd } from '../../shared/aiCost'
import { AI_AGENT_ROLES, AI_PANEL_CALLS, describeAgentFinding, describeDecider } from '../../shared/aiPanel'
import { formatUtcTime } from '../backtest/formatTradeTime'
import { formatQuotePrice } from '../utils/formatCurrency'
import { horizonLabel, reasonLabel, recommendationColor } from './agentStyles'

interface SignalCardProps {
  decision: AiSignalDecision
  interval: Interval
  quoteAsset: string
  /** Unix seconds. Passed in rather than read here so the card says the same thing as whatever
   * rendered it, and so "stale" can be shown without the card owning a timer. */
  nowSec: number
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div style={{ minWidth: 90 }}>
      <div style={{ fontSize: '0.64rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div style={{ marginTop: '0.2rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}

function Badge({ text, color }: { text: string; color: string }): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: '0.66rem',
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: '0.1rem 0.5rem'
      }}
    >
      {text}
    </span>
  )
}

/** One decision, in full: what the model said, why, and what saying it cost. */
export function SignalCard({ decision, interval, quoteAsset, nowSec }: SignalCardProps): React.JSX.Element {
  const color = recommendationColor(decision.recommendation)
  const detail = decision.detail ?? null
  const unusable = decision.error ?? decision.rejected ?? null
  // A decision belongs to ONE candle. Once that candle has closed the decision can no longer act,
  // and showing it without saying so invites reading an hour-old call as the current one.
  const stale = nowSec >= decision.candleTime + INTERVAL_SECONDS[interval]
  const usage = decision.usage ?? null
  const agents = decision.agents ?? null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
        padding: '1rem',
        background: 'var(--bg-app)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color, fontWeight: 700, fontSize: '1.05rem', textTransform: 'uppercase' }}>
          {decision.recommendation === 'buy' ? <ArrowUp size={16} /> : decision.recommendation === 'sell' ? <ArrowDown size={16} /> : <Minus size={16} />}
          {decision.recommendation}
        </div>
        <div style={{ flex: '1 1 160px', minWidth: 140 }}>
          <div style={{ height: 6, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.round(decision.confidence * 100)}%`, height: '100%', background: color }} />
          </div>
          <div style={{ marginTop: '0.25rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
            {(decision.confidence * 100).toFixed(0)}% confidence — how consistent the evidence looked to the model, not a
            probability of profit
          </div>
        </div>
        {decision.cached && <Badge text="cached" color="var(--text-secondary)" />}
        {stale && <Badge text="stale" color="var(--gold)" />}
        {decision.rejected && <Badge text="refused" color="var(--down)" />}
        {decision.error && <Badge text="failed" color="var(--down)" />}
      </div>

      {unusable !== null && (
        <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--down)', lineHeight: 1.5 }}>
          {decision.error
            ? `The model was not reached, so this is a safety hold and not a decision: ${unusable}`
            : `The model answered, but the answer was refused and is treated as a hold: ${unusable}`}
        </p>
      )}

      {detail && (
        <div style={{ display: 'flex', gap: '1.4rem', flexWrap: 'wrap' }}>
          <Field label="Regime" value={reasonLabel(detail.marketRegime)} />
          <Field label="Risk" value={detail.riskLevel} />
          <Field label="Horizon" value={horizonLabel(detail.horizonBars, interval)} />
          <Field label="Stop" value={detail.stopLoss === null ? '—' : formatQuotePrice(detail.stopLoss, quoteAsset)} />
          <Field label="Target" value={detail.takeProfit === null ? '—' : formatQuotePrice(detail.takeProfit, quoteAsset)} />
        </div>
      )}

      {detail && detail.reasonCodes.length > 0 && (
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {detail.reasonCodes.map((code) => (
            <span
              key={code}
              style={{
                fontSize: '0.72rem',
                color: 'var(--text-secondary)',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '0.15rem 0.5rem'
              }}
            >
              {reasonLabel(code)}
            </span>
          ))}
        </div>
      )}

      {decision.rationale && unusable === null && (
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>{decision.rationale}</p>
      )}

      {detail?.levelsNote && <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--gold)' }}>{detail.levelsNote}</p>}

      {/* A panel's decision was made from three reports. They are shown because the decision is
          only as good as what it was handed, and that is the part a single answer hides. */}
      {agents && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderTop: '1px solid var(--border)', paddingTop: '0.7rem' }}>
          <div style={{ fontSize: '0.64rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            What its analysts reported
          </div>
          {AI_AGENT_ROLES.map((role) => (
            <div key={role} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              <span style={{ fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>{role}</span>
              {': '}
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{describeAgentFinding(role, agents[role])}</span>
              {` · ${(agents[role].confidence * 100).toFixed(0)}% · ${agents[role].note}`}
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {describeDecider(decision.model)} · for the candle opening {formatUtcTime(decision.candleTime)} UTC
        {usage && (
          <>
            {' · '}
            {agents && `${AI_PANEL_CALLS} calls · `}
            {usage.promptTokens.toLocaleString()} in / {usage.completionTokens.toLocaleString()} out tokens ·{' '}
            {(usage.latencyMs / 1000).toFixed(1)}s ·{' '}
            {usage.costUsd === null
              ? 'cost not reported'
              : decision.cached
                ? `free now, ${formatUsd(usage.costUsd)} when first asked`
                : formatUsd(usage.costUsd)}
          </>
        )}
        . The stop and target are the model&apos;s own; nothing in this app trades on them.
      </div>
    </div>
  )
}
