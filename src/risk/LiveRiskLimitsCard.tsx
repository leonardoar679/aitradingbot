import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { LIVE_RISK_PCT_CHOICES } from '../../shared/liveLimits'
import { describeFeeRateMismatch } from '../../shared/observedFee'
import { Card } from '../components/Card'
import type { LiveTradingStatus } from '../../shared/ipc'
import { fieldLabelStyle, formButtonStyle, textInputStyle } from '../settings/formStyles'

/** The limits every real order is checked against in the main process: the largest order, the
 * day's notional, the day's loss, and the managed allocation. Editing them here changes nothing
 * about how they are enforced -- the main process validates every value it is sent. */
export function LiveRiskLimitsCard(): React.JSX.Element {
  const [status, setStatus] = useState<LiveTradingStatus | null>(null)
  const [maxOrderQuote, setMaxOrderQuote] = useState('')
  const [dailyCapQuote, setDailyCapQuote] = useState('')
  const [dailyLossLimitQuote, setDailyLossLimitQuote] = useState('')
  const [allocationQuote, setAllocationQuote] = useState('')
  const [riskPct, setRiskPct] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function refresh(): void {
    window.api.liveTrading.getStatus().then((s) => {
      setStatus(s)
      setMaxOrderQuote(String(s.maxOrderQuote))
      setDailyCapQuote(String(s.dailyCapQuote))
      setDailyLossLimitQuote(String(s.dailyLossLimitQuote))
      // Blank and 0 are different answers -- "not using an allocation" and "an allocation of
      // nothing" -- so an unset allocation must come back as an empty field, never as "0".
      setAllocationQuote(s.allocationQuote === null ? '' : String(s.allocationQuote))
      setRiskPct(String(s.riskPct))
    })
  }

  useEffect(() => {
    refresh()
  }, [])

  async function handleSave(): Promise<void> {
    setBusy(true)
    setSaved(false)
    setSaveError(null)
    try {
      await window.api.liveTrading.setConfig({
        maxOrderQuote: Number(maxOrderQuote),
        dailyCapQuote: Number(dailyCapQuote),
        dailyLossLimitQuote: Number(dailyLossLimitQuote),
        allocationQuote: allocationQuote.trim() === '' ? null : Number(allocationQuote),
        riskPct: Number(riskPct)
      })
      refresh()
      setSaved(true)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <Card title="Live trading limits">Loading…</Card>

  // The exchange reports what it really charged on every fill, so the app can say when its own
  // assumed rate is wrong instead of leaving someone to discover it in their balance.
  const feeMismatch = describeFeeRateMismatch(status.observedFeeRate)

  return (
    <Card title="Live trading limits">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.9rem' }}>
        <AlertTriangle size={15} color="var(--down)" style={{ flexShrink: 0, marginTop: 2 }} />
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
          Max order size has an absolute, code-only ceiling of {status.hardMaxOrderQuote} — nothing here, and no bug
          in this app, can place a live order above that no matter what's typed below. The daily cap bounds live
          order notional (used {status.dailyUsedQuote.toFixed(2)} / {status.dailyCapQuote} so far). The daily loss
          limit is the real one — it's realized P&amp;L from closed live positions (today: {status.realizedPnlToday.toFixed(2)}
          ), and breaching it auto-disarms live trading for the rest of the day. Closing a position is never blocked
          by any of these — they only ever bound new/opening orders.
        </p>
      </div>
      {feeMismatch !== null && (
        <p
          style={{
            fontSize: '0.76rem',
            color: 'var(--down)',
            border: '1px solid var(--down)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.55rem 0.7rem',
            margin: '0 0 0.9rem',
            lineHeight: 1.5
          }}
        >
          {feeMismatch}
        </p>
      )}
      <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px' }}>
          <label style={fieldLabelStyle()}>Max Order Size (quote, ≤ {status.hardMaxOrderQuote})</label>
          <input
            type="number"
            max={status.hardMaxOrderQuote}
            value={maxOrderQuote}
            onChange={(e) => setMaxOrderQuote(e.target.value)}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label style={fieldLabelStyle()}>Daily Cap (quote)</label>
          <input type="number" value={dailyCapQuote} onChange={(e) => setDailyCapQuote(e.target.value)} style={textInputStyle()} />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label style={fieldLabelStyle()}>Daily Loss Limit (quote)</label>
          <input
            type="number"
            value={dailyLossLimitQuote}
            onChange={(e) => setDailyLossLimitQuote(e.target.value)}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label style={fieldLabelStyle()}>Managed Allocation (quote, blank = none)</label>
          <input
            type="number"
            min="0"
            placeholder="none"
            value={allocationQuote}
            onChange={(e) => setAllocationQuote(e.target.value)}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label style={fieldLabelStyle()}>A real order from a call risks (% of the allocation)</label>
          <select aria-label="The share of the allocation a real order from a call risks" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} style={textInputStyle()}>
            {LIVE_RISK_PCT_CHOICES.map((choice) => (
              <option key={choice} value={String(choice)}>
                {choice}%
              </option>
            ))}
          </select>
        </div>
      </div>
      <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0.7rem 0 0', lineHeight: 1.5 }}>
        An order form filled in from a model's call opens with its amount sized by this: the share of the managed allocation, or of the daily cap
        without one, that the call's stop would lose after fees, under the max order size. A suggestion, which you may change before placing;
        the model is never asked for an amount, and no gate reads it.
      </p>
      <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0.7rem 0 0', lineHeight: 1.5 }}>
        {status.allocationQuote === null
          ? 'A managed allocation is the only limit here that bounds the total rather than the day. Every cap above resets at midnight UTC, so a 50-a-day cap still permits 1,500 over a month. Set an amount and this app will never have more than that at work at once. Your funds never move — they stay on your exchange, under your keys; this is permission, not a deposit.'
          : `This app may have ${status.allocationQuote.toFixed(2)} at work at once, and currently has ${status.allocationCommittedQuote.toFixed(2)} — counting what open positions cost and what resting buy orders have reserved. ${Math.max(status.allocationQuote - status.allocationCommittedQuote, 0).toFixed(2)} is free. Your funds have not moved: they are on your exchange, under your keys. Clear the field to trade without an allocation.`}
      </p>
      <div style={{ marginTop: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <button onClick={() => void handleSave()} disabled={busy} style={{ ...formButtonStyle('primary'), opacity: busy ? 0.6 : 1 }}>
          Save
        </button>
        {saved && <span style={{ fontSize: '0.78rem', color: 'var(--up)' }}>Saved</span>}
        {saveError && <span style={{ fontSize: '0.78rem', color: 'var(--down)' }}>Failed to save: {saveError}</span>}
      </div>
    </Card>
  )
}
