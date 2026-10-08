import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { describeTradeCosts, modelTradeCosts, tradeCosts, type ModelTradeCosts } from '../../shared/aiCostPerTrade'
import type { AiCallRecord } from '../../shared/aiLedger'
import { describeDecider } from '../../shared/aiPanel'
import type { ExecutorConfig } from '../../shared/ipc'
import { cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'

/** The ledger is read back this far: the watch's trades are hours long, so a trade older than this
 * had its calls paid for before the window. */
const DAYS = 30
const ROWS_READ = 5000

/** Cents matter here: a call costs a fraction of one, so under a dollar four places are shown. */
const usd = (value: number | null): string => (value === null ? '—' : value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`)

/** What an answer costs a trade (shared/aiCostPerTrade.ts): by model, from the ledger and the
 * executors on file. It reads; nothing here asks, stores or acts. */
export function AiCostPerTradeCard({ executors }: { executors: ExecutorConfig[] | null }): React.JSX.Element {
  const [rows, setRows] = useState<AiCallRecord[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const sinceSec = Math.floor(Date.now() / 1000) - DAYS * 86_400
    window.api.ai.listCalls({ sinceSec, limit: ROWS_READ }).then(
      (page) => {
        if (!cancelled) setRows(page.rows)
      },
      (failure: unknown) => {
        if (!cancelled) setProblem(failure instanceof Error ? failure.message : String(failure))
      }
    )
    return (): void => {
      cancelled = true
    }
  }, [])

  const entries: ModelTradeCosts[] | null = useMemo(() => (executors === null || rows === null ? null : modelTradeCosts(tradeCosts(executors, rows))), [executors, rows])

  return (
    <Card title="What an answer costs a trade">
      <p style={{ ...noteStyle, marginTop: 0 }}>
        For each of the watch&apos;s paper trades, what the ledger says was spent to make it: every call the watch made on its event, whichever model
        answered, the reviewer&apos;s look at it and the exit check&apos;s looks at the trade. By the model the trade followed, over the last {DAYS} days of
        calls. Read from the records; nothing here is stored or acted on.
      </p>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>The ledger could not be read: {problem}</p>}
      {entries === null && problem === null && <p style={noteStyle}>Reading…</p>}
      {entries !== null && entries.length === 0 && <p style={noteStyle}>The watch has opened no paper trade in the last {DAYS} days of calls.</p>}
      {entries !== null && entries.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>Model</th>
                <th style={headCellStyle}>Trades</th>
                <th style={headCellStyle}>Closed (won)</th>
                <th style={headCellStyle}>AI spend</th>
                <th style={headCellStyle}>A trade</th>
                <th style={headCellStyle}>A winning trade</th>
                <th style={headCellStyle}>A dollar of net result</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.model} style={{ borderBottom: '1px solid var(--border)' }} title={describeTradeCosts(entry)}>
                  <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>{describeDecider(entry.model)}</td>
                  <td style={cellStyle}>{entry.trades}</td>
                  <td style={cellStyle}>
                    {entry.closed} ({entry.wins})
                  </td>
                  <td style={cellStyle}>{usd(entry.costUsd)}</td>
                  <td style={cellStyle}>{usd(entry.perTradeUsd)}</td>
                  <td style={cellStyle}>{usd(entry.perWinUsd)}</td>
                  <td style={cellStyle}>{entry.perNetDollar === null ? '—' : `${(entry.perNetDollar * 100).toFixed(1)}¢`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
