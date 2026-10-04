import { useCallback, useEffect, useState } from 'react'
import { Activity, Atom, History, Wallet } from 'lucide-react'
import { Card } from '../components/Card'
import { StatCard } from '../components/StatCard'
import { AI_PROVIDER_LABEL } from '../../shared/aiSignal'
import { formatUsd, type AiConfig, type AiKeyInfo, type AiUsageByModel, type AiUsageSummary } from '../../shared/aiCost'
import { describeError } from '../utils/ipcError'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from './agentStyles'

function total(rows: AiUsageByModel[], pick: (row: AiUsageByModel) => number): number {
  return rows.reduce((sum, row) => sum + pick(row), 0)
}

function UsageTable({ rows }: { rows: AiUsageByModel[] }): React.JSX.Element {
  if (rows.length === 0) return <p style={noteStyle}>No calls in this period.</p>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headCellStyle}>Model</th>
            <th style={headCellStyle}>Calls</th>
            <th style={headCellStyle}>Failed</th>
            <th style={headCellStyle}>Refused</th>
            <th style={headCellStyle}>Tokens in</th>
            <th style={headCellStyle}>Tokens out</th>
            <th style={headCellStyle}>Avg. latency</th>
            <th style={headCellStyle}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.model}>
              <td style={{ ...cellStyle, fontWeight: 600 }}>{row.model}</td>
              <td style={cellStyle}>{row.calls.toLocaleString()}</td>
              <td style={{ ...cellStyle, color: row.failed > 0 ? 'var(--down)' : 'var(--text-primary)' }}>{row.failed.toLocaleString()}</td>
              <td style={{ ...cellStyle, color: row.rejected > 0 ? 'var(--down)' : 'var(--text-primary)' }}>{row.rejected.toLocaleString()}</td>
              <td style={cellStyle}>{row.promptTokens.toLocaleString()}</td>
              <td style={cellStyle}>{row.completionTokens.toLocaleString()}</td>
              <td style={cellStyle}>{row.averageLatencyMs !== null ? `${(row.averageLatencyMs / 1000).toFixed(1)}s` : '—'}</td>
              <td style={cellStyle}>{formatUsd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** What has been spent, and the limit on spending more.
 *
 * Everything shown is read from the ledger on disk and from two free requests about the key. The
 * budget is edited here and enforced in the main process, immediately before every paid call. */
export function UsageTab(): React.JSX.Element {
  const [summary, setSummary] = useState<AiUsageSummary | null>(null)
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [keyInfo, setKeyInfo] = useState<AiKeyInfo | null>(null)
  const [keyProblem, setKeyProblem] = useState<string | null>(null)
  const [capInput, setCapInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const [nextSummary, nextConfig] = await Promise.all([window.api.ai.usageSummary(), window.api.ai.getConfig()])
      setSummary(nextSummary)
      setConfig(nextConfig)
      setCapInput(String(nextConfig.dailyCapUsd))
      try {
        setKeyInfo(await window.api.ai.keyInfo())
        setKeyProblem(null)
      } catch (failure) {
        // No key is an ordinary state here, not a failure of the page: the ledger and the budget
        // are still worth showing.
        setKeyInfo(null)
        setKeyProblem(describeError(failure))
      }
    } catch (failure) {
      setMessage({ ok: false, text: describeError(failure) })
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function saveCap(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      // Number('') is 0, and 0 is a real setting here -- it switches AI calls off. A blank field
      // must not be read as a decision to do that.
      if (capInput.trim() === '') throw new Error('Enter a number of dollars. 0 switches AI calls off.')
      const next = await window.api.ai.setConfig({ dailyCapUsd: Number(capInput) })
      setConfig(next)
      setCapInput(String(next.dailyCapUsd))
      setMessage({ ok: true, text: next.dailyCapUsd > 0 ? 'Budget saved.' : 'Budget set to $0: AI calls are switched off.' })
    } catch (failure) {
      setMessage({ ok: false, text: describeError(failure) })
    } finally {
      setBusy(false)
    }
  }

  const today = summary?.today ?? []
  const callsToday = total(today, (row) => row.calls)
  const answeredToday = total(today, (row) => row.calls - row.failed)
  const latencyToday = total(today, (row) => (row.averageLatencyMs ?? 0) * (row.calls - row.failed))

  return (
    <>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <StatCard
          icon={Wallet}
          label="Spent today"
          value={config ? formatUsd(config.spentTodayUsd) : '—'}
          sub={config ? `of a ${formatUsd(config.dailyCapUsd)} daily budget` : undefined}
          subColor={config && config.spentTodayUsd >= config.dailyCapUsd ? 'var(--down)' : undefined}
        />
        <StatCard icon={Atom} label="Calls today" value={callsToday.toLocaleString()} sub={`${total(today, (row) => row.failed)} failed`} />
        <StatCard
          icon={History}
          label="Tokens today"
          value={(total(today, (row) => row.promptTokens) + total(today, (row) => row.completionTokens)).toLocaleString()}
        />
        <StatCard
          icon={Activity}
          label="Average latency"
          value={answeredToday > 0 ? `${(latencyToday / answeredToday / 1000).toFixed(1)}s` : '—'}
        />
      </div>

      <Card title="Daily AI budget">
        <p style={{ ...noteStyle, marginBottom: '0.8rem' }}>
          The most this app may spend on model calls in one UTC day. It is checked before every paid call; when it is
          reached, whatever was running stops and says so, and every answer already generated stays cached. It is a
          guard against something left running, not a substitute for the confirmation each paid run still asks for.
          Set it to 0 to switch AI calls off.
        </p>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>$</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={capInput}
            onChange={(event) => setCapInput(event.target.value)}
            style={{ ...inputStyle(), width: 110 }}
            aria-label="Daily AI budget in dollars"
          />
          <button onClick={() => void saveCap()} disabled={busy} style={buttonStyle('primary', busy)}>
            Save
          </button>
          {message && <span style={{ fontSize: '0.78rem', color: message.ok ? 'var(--up)' : 'var(--down)' }}>{message.text}</span>}
        </div>
      </Card>

      <Card
        title={`${AI_PROVIDER_LABEL} key`}
        actions={
          <button onClick={() => void load()} disabled={busy} style={buttonStyle('secondary', busy)}>
            {busy ? 'Loading…' : 'Refresh'}
          </button>
        }
      >
        {keyInfo ? (
          <p style={{ ...noteStyle, color: 'var(--text-secondary)' }}>
            {keyInfo.label || 'Key'} · {formatUsd(keyInfo.usageUsd)} used in total ·{' '}
            {keyInfo.limitRemainingUsd !== null
              ? `${formatUsd(keyInfo.limitRemainingUsd)} left of this key's own ${formatUsd(keyInfo.limitUsd ?? 0)} limit`
              : `no spending limit set on this key at ${AI_PROVIDER_LABEL}`}
            {keyInfo.isFreeTier && ' · free tier'}
          </p>
        ) : (
          <p style={noteStyle}>{keyProblem ?? 'Loading…'}</p>
        )}
      </Card>

      <Card title="Today, by model">
        <UsageTable rows={today} />
      </Card>
      <Card title="Last 30 days, by model">
        <UsageTable rows={summary?.last30Days ?? []} />
        {summary !== null && summary.skippedLines > 0 && (
          <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.6rem' }}>
            {summary.skippedLines} ledger line{summary.skippedLines === 1 ? '' : 's'} could not be read, so these totals
            are missing {summary.skippedLines === 1 ? 'it' : 'them'}.
          </p>
        )}
      </Card>
    </>
  )
}
