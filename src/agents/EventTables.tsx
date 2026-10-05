import { useState } from 'react'
import { formatUsd } from '../../shared/aiCost'
import { EVENT_BENCHMARK_STAKE_USD, rollingResults, type EventBenchmarkRow, type EventContribution, type RollingWindow } from '../../shared/aiEventBenchmark'
import { describeDecider } from '../../shared/aiPanel'
import { cellStyle, headCellStyle, inputStyle, noteStyle, signedPct } from './agentStyles'

// The tables a comparison on events is shown in (shared/aiEventBenchmark.ts). Two things show
// them: the benchmark, over events found in history, and the leaderboard of what the watch asked
// live. They are the same tables so that the two can be read against each other.

function rate(row: EventBenchmarkRow): string {
  if (row.closed === 0) return '—'
  if (row.winRatePct === null) return `too few (${row.wins} of ${row.closed})`
  return `${row.winRatePct.toFixed(0)}% ± ${(row.winRateMarginPct ?? 0).toFixed(0)} (${row.wins} of ${row.closed})`
}

export function pct(value: number | null): React.JSX.Element {
  const { text, color } = signedPct(value)
  return <span style={{ color }}>{text}</span>
}

/** An amount in R, signed and coloured: what trades made over what their own stops would have
 * lost (shared/aiOpportunityOutcome.ts). */
export function inR(value: number): React.JSX.Element {
  return <span style={{ color: value > 0 ? 'var(--up)' : value < 0 ? 'var(--down)' : undefined }}>{`${value > 0 ? '+' : ''}${value.toFixed(2)} R`}</span>
}

function usd(value: number | null): React.JSX.Element {
  if (value === null) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  return <span style={{ color: value >= 0 ? 'var(--up)' : 'var(--down)' }}>{`${value >= 0 ? '+' : '−'}${formatUsd(Math.abs(value))}`}</span>
}

export function ResultsTable({
  title,
  rows,
  models,
  label
}: {
  title: string
  rows: EventBenchmarkRow[]
  models: boolean
  /** How a row's name is shown, where it is not a model's id or a rule's name. */
  label?: (name: string) => string
}): React.JSX.Element {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headCellStyle}>{title}</th>
            {models && <th style={headCellStyle}>Answered</th>}
            <th style={headCellStyle}>Buy</th>
            <th style={headCellStyle}>Sell</th>
            <th style={headCellStyle}>No trade</th>
            <th style={headCellStyle}>Acted on</th>
            <th style={headCellStyle}>Expired</th>
            <th style={headCellStyle}>Won</th>
            <th style={headCellStyle}>Net, added up</th>
            <th style={headCellStyle}>In R, added up</th>
            <th style={headCellStyle}>A trade</th>
            <th style={headCellStyle}>Gains ÷ losses</th>
            <th style={headCellStyle}>Deepest fall</th>
            <th style={headCellStyle}>Avg. hold</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              {/* A label is longer than a model's id, and wraps rather than pushing the last columns off the card. */}
              <td style={{ ...cellStyle, fontWeight: 600, ...(label !== undefined ? { whiteSpace: 'normal', minWidth: '9rem' } : {}) }}>
                {label !== undefined ? label(row.name) : models ? describeDecider(row.name) : row.name}
              </td>
              {models && <td style={cellStyle}>{row.answered}</td>}
              <td style={cellStyle}>{row.longs}</td>
              <td style={cellStyle}>{row.shorts}</td>
              <td style={cellStyle}>
                {row.noTrades}
                {row.refused > 0 && <span style={{ color: 'var(--down)' }}> +{row.refused} refused</span>}
              </td>
              <td style={cellStyle}>
                {row.actionable}
                {row.unsettled > 0 && <span style={{ color: 'var(--text-muted)' }}> ({row.unsettled} unsettled)</span>}
              </td>
              <td style={cellStyle}>{row.expired}</td>
              <td style={cellStyle}>{rate(row)}</td>
              <td style={cellStyle}>{row.closed === 0 ? '—' : pct(row.netSumPct)}</td>
              <td style={cellStyle}>{row.closed === 0 ? '—' : inR(row.rSum)}</td>
              <td style={cellStyle}>{pct(row.meanNetPct)}</td>
              <td style={cellStyle}>{row.profitFactor === null ? '—' : row.profitFactor.toFixed(2)}</td>
              <td style={cellStyle}>{row.closed === 0 ? '—' : `${row.maxDrawdownPct.toFixed(2)}%`}</td>
              <td style={cellStyle}>{row.meanHoldMinutes === null ? '—' : `${row.meanHoldMinutes.toFixed(0)} min`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function CostTable({ rows }: { rows: EventBenchmarkRow[] }): React.JSX.Element {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headCellStyle}>Model</th>
            <th style={headCellStyle}>Median wait</th>
            <th style={headCellStyle}>Cost of these answers</th>
            <th style={headCellStyle}>Trades at {formatUsd(EVENT_BENCHMARK_STAKE_USD)} each</th>
            <th style={headCellStyle}>After the answers&apos; cost</th>
            <th style={headCellStyle}>Per $1 of answers</th>
            <th style={headCellStyle}>Best / worst inside a trade</th>
            <th style={headCellStyle}>First third</th>
            <th style={headCellStyle}>Second</th>
            <th style={headCellStyle}>Third</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td style={{ ...cellStyle, fontWeight: 600 }}>{describeDecider(row.name)}</td>
              <td style={cellStyle}>{row.medianLatencyMs === null ? '—' : `${(row.medianLatencyMs / 1000).toFixed(1)}s`}</td>
              <td style={cellStyle}>{row.costUsd === null ? '—' : formatUsd(row.costUsd)}</td>
              <td style={cellStyle}>{row.closed === 0 ? '—' : usd((row.netSumPct / 100) * EVENT_BENCHMARK_STAKE_USD)}</td>
              <td style={cellStyle}>{row.closed === 0 ? '—' : usd(row.netAfterAiCostUsd)}</td>
              <td style={cellStyle}>{row.closed === 0 ? '—' : usd(row.perAiDollarUsd)}</td>
              <td style={cellStyle}>
                {row.meanBestPct === null ? '—' : pct(row.meanBestPct)} / {row.meanWorstPct === null ? '—' : pct(row.meanWorstPct)}
              </td>
              {row.segments.map((segment, index) => (
                <td key={index} style={cellStyle}>
                  {segment.trades === 0 ? '—' : pct(segment.netSumPct)}
                  {segment.trades > 0 && <span style={{ color: 'var(--text-muted)' }}> ({segment.trades})</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const muted = (text: string): React.JSX.Element => <span style={{ color: 'var(--text-muted)' }}>{text}</span>

/** A heading that may run to two lines, for a table with more columns than a row of one-line
 * headings leaves room for. */
const wrappedHeadStyle: React.CSSProperties = { ...headCellStyle, whiteSpace: 'normal', verticalAlign: 'bottom', minWidth: '5rem' }

/** What each model changed about following every event (EventContribution): its own trades, the
 * fixed bracket on the same calls, and the rule on the events it let go. `models` are the models'
 * own rows, in the same order. */
export function ContributionTable({ contributions, models }: { contributions: EventContribution[]; models: EventBenchmarkRow[] }): React.JSX.Element {
  const added = (row: EventBenchmarkRow | undefined): React.JSX.Element =>
    row === undefined || row.closed === 0 ? (
      muted('—')
    ) : (
      <>
        {pct(row.netSumPct)} {muted(`(${row.closed})`)}
      </>
    )
  const aTrade = (value: number | null): React.JSX.Element => (value === null ? muted('too few') : pct(value))
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={wrappedHeadStyle}>Model</th>
            <th style={wrappedHeadStyle}>With / against the move</th>
            <th style={wrappedHeadStyle}>Its calls, its levels</th>
            <th style={wrappedHeadStyle}>Same calls, fixed bracket</th>
            <th style={wrappedHeadStyle}>Events it left, followed</th>
            <th style={wrappedHeadStyle}>A trade, against the rule</th>
            <th style={wrappedHeadStyle}>From its choice of events</th>
            <th style={wrappedHeadStyle}>From its levels</th>
          </tr>
        </thead>
        <tbody>
          {contributions.map((entry, index) => (
            <tr key={entry.model}>
              <td style={{ ...cellStyle, fontWeight: 600 }}>{describeDecider(entry.model)}</td>
              <td style={cellStyle}>
                {entry.withTheMove} / {entry.againstTheMove}
              </td>
              <td style={cellStyle}>{added(models[index])}</td>
              <td style={cellStyle}>{added(entry.bracket)}</td>
              <td style={cellStyle}>{added(entry.left)}</td>
              <td style={cellStyle}>{aTrade(entry.againstRulePct)}</td>
              <td style={cellStyle}>{aTrade(entry.choicePct)}</td>
              <td style={cellStyle}>{aTrade(entry.levelsPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** How each row's trades ended. A stop that is hit nearly every time and a target that is never
 * reached are two different ways to lose, and a net figure shows neither. */
export function ExitsTable({ rows }: { rows: EventBenchmarkRow[] }): React.JSX.Element {
  const share = (count: number, of: number): React.JSX.Element =>
    of === 0 ? (
      muted('—')
    ) : (
      <>
        {count} {muted(`(${Math.round((count / of) * 100)}%)`)}
      </>
    )
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headCellStyle}>Row</th>
            <th style={headCellStyle}>Closed</th>
            <th style={headCellStyle}>At the target</th>
            <th style={headCellStyle}>At the stop</th>
            <th style={headCellStyle}>Time ran out</th>
            <th style={headCellStyle}>Never filled</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td style={{ ...cellStyle, fontWeight: 600 }}>{describeDecider(row.name)}</td>
              <td style={cellStyle}>{row.closed}</td>
              <td style={cellStyle}>{share(row.exits.target, row.closed)}</td>
              <td style={cellStyle}>{share(row.exits.stop, row.closed)}</td>
              <td style={cellStyle}>{share(row.exits.time, row.closed)}</td>
              <td style={cellStyle}>{share(row.expired, row.actionable)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** How each row has done lately: its last 10, 50 and 100 closed trades, and the last 7 and 30
 * days. Net added up, with the closed trades behind it in brackets; a window with fewer trades
 * than its name says holds all there are. */
export function RollingTable({ rows, nowSec }: { rows: EventBenchmarkRow[]; nowSec: number }): React.JSX.Element {
  const cell = (window: RollingWindow): React.JSX.Element =>
    window.trades === 0 ? (
      muted('—')
    ) : (
      <>
        {pct(window.netSumPct)}, {inR(window.rSum)} {muted(`(${window.wins} of ${window.trades} won)`)}
      </>
    )
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={wrappedHeadStyle}>Lately</th>
            <th style={wrappedHeadStyle}>Last 10 trades</th>
            <th style={wrappedHeadStyle}>Last 50</th>
            <th style={wrappedHeadStyle}>Last 100</th>
            <th style={wrappedHeadStyle}>Last 7 days</th>
            <th style={wrappedHeadStyle}>Last 30 days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rolling = rollingResults(row.trades, nowSec)
            return (
              <tr key={row.name}>
                <td style={{ ...cellStyle, fontWeight: 600 }}>{describeDecider(row.name)}</td>
                {rolling.lastTrades.map((window) => (
                  <td key={`t${window.count}`} style={cellStyle}>
                    {cell(window)}
                  </td>
                ))}
                {rolling.lastDays.map((window) => (
                  <td key={`d${window.days}`} style={cellStyle}>
                    {cell(window)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function SlicesTable({ rows }: { rows: EventBenchmarkRow[] }): React.JSX.Element {
  const [picked, setPicked] = useState(rows[0]?.name ?? '')
  const row = rows.find((entry) => entry.name === picked) ?? rows[0]
  if (!row) return <p style={noteStyle}>Nothing to break down yet.</p>
  const label: Record<string, string> = {
    type: 'By event',
    side: 'By side',
    hold: 'By holding time',
    confidence: 'By confidence',
    size: "By the pair's trading",
    btc: "By Bitcoin's four hours",
    company: 'By the move'
  }
  return (
    <>
      <select aria-label="Row to break down" value={row.name} onChange={(event) => setPicked(event.target.value)} style={{ ...inputStyle(), marginBottom: '0.7rem' }}>
        {rows.map((entry) => (
          <option key={entry.name} value={entry.name}>
            {describeDecider(entry.name)}
          </option>
        ))}
      </select>
      {row.slices.length === 0 ? (
        <p style={noteStyle}>No closed trades to break down.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>Trades</th>
                <th style={headCellStyle}>Of them</th>
                <th style={headCellStyle}>Closed</th>
                <th style={headCellStyle}>Won</th>
                <th style={headCellStyle}>Net, added up</th>
                <th style={headCellStyle}>A trade</th>
              </tr>
            </thead>
            <tbody>
              {row.slices.map((slice) => (
                <tr key={`${slice.by}:${slice.key}`}>
                  <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{label[slice.by]}</td>
                  <td style={{ ...cellStyle, fontWeight: 600 }}>{slice.by === 'type' ? slice.key.replace(/_/g, ' ') : slice.key}</td>
                  <td style={cellStyle}>{slice.trades}</td>
                  <td style={cellStyle}>{slice.wins}</td>
                  <td style={cellStyle}>{pct(slice.netSumPct)}</td>
                  <td style={cellStyle}>{slice.meanNetPct === null ? <span style={{ color: 'var(--text-muted)' }}>too few</span> : pct(slice.meanNetPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
