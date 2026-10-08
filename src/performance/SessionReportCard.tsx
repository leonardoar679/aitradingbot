import { useState } from 'react'
import { Card } from '../components/Card'
import { describeR } from '../../shared/paperRisk'
import { REPORT_LINES, sessionReportCsv, type ReportGate, type ReportSpan, type SessionReport } from '../../shared/shadowReport'
import { buttonStyle, cellStyle, headCellStyle, noteStyle, tabButtonStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'
import { buildSessionReport, sessionReportBrowserDeps, spanStart } from './sessionReport'

const SESSION_KEY = 'sessionReport.startedAt'

/** When "Start a session" was last pressed, in this window's storage: a convenience, read with
 * care, and the report works without it. */
function readSessionStart(): number | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY)
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function writeSessionStart(sec: number): void {
  try {
    window.localStorage.setItem(SESSION_KEY, String(sec))
  } catch {
    // Not kept: the session still starts now for as long as the page is open.
  }
}

function clock(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const SPANS: { span: ReportSpan; label: string }[] = [
  { span: 'hour', label: 'Last hour' },
  { span: 'twelve', label: 'Last 12 hours' },
  { span: 'day', label: 'Last 24 hours' },
  { span: 'session', label: 'This session' }
]

function statusStyle(gate: ReportGate, applies: boolean): React.CSSProperties {
  const color = !applies ? 'var(--text-muted)' : gate.status === 'pass' ? 'var(--up)' : gate.status === 'fail' ? 'var(--down)' : 'var(--text-secondary)'
  return { ...cellStyle, color, fontWeight: 700, whiteSpace: 'nowrap' }
}

function amounts(list: { asset: string; amount: number }[], signed = true): string {
  if (list.length === 0) return 'none'
  return list.map((entry) => `${signed && entry.amount > 0 ? '+' : ''}${Number(entry.amount.toPrecision(4))} ${entry.asset}`).join(', ')
}

/** The figures, as lines. */
function figures(report: SessionReport): { title: string; lines: string[] }[] {
  const { calls, paper } = report
  const rate = (value: number | null): string => (value === null ? 'none to count' : `${(value * 100).toFixed(1)}%`)
  return [
    { title: 'Events', lines: [`${report.events.raised} raised, ${report.events.urgent} of them urgent; ${report.events.takenUp} put to the watch's models.`] },
    {
      title: 'AI calls',
      lines: [
        `${calls.total} made: ${calls.answered} answered (${rate(calls.successRate)}), ${calls.valid} valid (${rate(calls.validationRate)}), ${calls.failed} failed.`,
        `Latency ${calls.latencyP50Ms === null ? '—' : `${(calls.latencyP50Ms / 1000).toFixed(1)} s`} at the median, ${calls.latencyP95Ms === null ? '—' : `${(calls.latencyP95Ms / 1000).toFixed(1)} s`} at the 95th percentile; $${calls.costUsd.toFixed(4)} in all.`,
        `The watch's answers: ${report.answers.buy} BUY, ${report.answers.sell} SELL, ${report.answers.hold} HOLD, ${report.answers.noTrade} NO TRADE (a side it would not act on).`
      ]
    },
    {
      title: 'Paper trades',
      lines: [
        `${paper.opened} opened (${paper.openedWatch} by the watch, ${paper.openedNews} by the news rules), ${paper.ended} ended, ${paper.open} open now.`,
        `Net ${amounts(paper.net)} after fees of ${amounts(paper.fees, false)}${paper.rTrades === 0 ? '' : `; ${describeR(paper.r)} over the ${paper.rTrades} with a stop`}. Reported, not gated.`,
        `Furthest for a trade while it was held: ${paper.bestPct === null ? '—' : `${paper.bestPct.toFixed(2)}%`}; furthest against: ${paper.worstPct === null ? '—' : `${paper.worstPct.toFixed(2)}%`}.`,
        `From the event to the paper trade: ${paper.signalAgeSec.median === null ? '—' : `${Math.round(paper.signalAgeSec.median)} s`} at the median, ${paper.signalAgeSec.max === null ? '—' : `${Math.round(paper.signalAgeSec.max)} s`} at most.`,
        paper.refused.length === 0 ? 'None refused this session.' : `Refused this session: ${paper.refused.map((entry) => `${entry.count} × ${entry.reason}`).join(' ')}`
      ]
    },
    {
      title: 'Alerts and the stream',
      lines: [
        `Alerts this session: ${report.alerts.critical} CRITICAL, ${report.alerts.high} HIGH, ${report.alerts.watch} WATCH, ${report.alerts.info} INFO.`,
        report.stream === null
          ? "The stream's log could not be read."
          : `The stream: ${report.stream.connects} connects and ${report.stream.drops} drops since the app started; ${report.stream.gaps} gaps in the span, ${report.stream.gapSeconds} s in all, the longest ${report.stream.longestGapSeconds} s. It is on ${report.stream.host ?? 'no host yet'}; it moved host ${report.stream.hostSwitches} ${report.stream.hostSwitches === 1 ? 'time' : 'times'} since the app started, and the data host moved ${report.stream.dataHostSwitches}.`
      ]
    }
  ]
}

/** The session report on Performance (shared/shadowReport.ts): what the app did over the last hour,
 * the last twelve hours, the last day, or since a session was started, and whether it held to the
 * V3 document's gates for its test runs. It reads, and asks nothing; saving it writes a file a person names. */
export function SessionReportCard(): React.JSX.Element {
  const [session, setSession] = useState<number | null>(readSessionStart)
  const [report, setReport] = useState<SessionReport | null>(null)
  const [busy, setBusy] = useState<ReportSpan | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  async function build(span: ReportSpan): Promise<void> {
    if (busy !== null) return
    setBusy(span)
    setNote(null)
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      setReport(await buildSessionReport(span, spanStart(span, nowSec, session), sessionReportBrowserDeps))
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      setBusy(null)
    }
  }

  function startSession(): void {
    const nowSec = Math.floor(Date.now() / 1000)
    writeSessionStart(nowSec)
    setSession(nowSec)
    setReport(null)
    setNote({ ok: true, text: `A session started at ${clock(nowSec)}. "This session" reports from then.` })
  }

  async function save(format: 'json' | 'csv'): Promise<void> {
    if (report === null) return
    setNote(null)
    try {
      const outcome = await window.api.backtest.exportSave({
        defaultFileName: `session-report-${new Date(report.toSec * 1000).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${format}`,
        content: format === 'json' ? JSON.stringify(report, null, 2) : sessionReportCsv(report),
        format
      })
      if (outcome.status === 'saved') setNote({ ok: true, text: `Saved to ${outcome.filePath}` })
      else if (outcome.status === 'error') setNote({ ok: false, text: `Could not save the file: ${outcome.message}` })
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    }
  }

  return (
    <Card title="Session report">
      <p style={{ ...noteStyle, marginTop: 0 }}>
        What the app did over the last hour, the last twelve hours, the last day, or since a session was started, and whether it held to the gates the V3 document sets for
        its test runs: nothing traded on a stale or bad price, from an invalid answer, twice or past a limit; more than {REPORT_LINES.aiSuccess * 100}% of calls answered
        and {REPORT_LINES.validation * 100}% valid; and over twelve hours, every recommendation with an outcome, every trade traced, costs charged and news linked.
        It reads what is on file and asks nothing. Profit is reported, not gated.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {SPANS.map(({ span, label }) => (
          <button key={span} onClick={() => void build(span)} disabled={busy !== null} style={tabButtonStyle(report?.span === span)}>
            {busy === span ? 'Reading…' : label}
          </button>
        ))}
        <button onClick={startSession} disabled={busy !== null} style={buttonStyle('secondary', busy !== null)}>
          Start a session
        </button>
        <button onClick={() => void save('json')} disabled={report === null} style={buttonStyle('secondary', report === null)}>
          Save as JSON
        </button>
        <button onClick={() => void save('csv')} disabled={report === null} style={buttonStyle('secondary', report === null)}>
          Save as CSV
        </button>
      </div>
      <p style={{ ...noteStyle, margin: '0.4rem 0 0' }}>
        {session === null ? 'No session started: "This session" reports from when the app opened.' : `The session started at ${clock(session)}.`}
      </p>
      {note !== null && <p style={{ ...noteStyle, color: note.ok ? 'var(--text-secondary)' : 'var(--down)', margin: '0.4rem 0 0' }}>{note.text}</p>}
      {report !== null && (
        <>
          <p style={{ ...noteStyle, margin: '0.7rem 0 0', color: 'var(--text-primary)' }}>
            From {clock(report.fromSec)} to {clock(report.toSec)}:{' '}
            <strong style={{ color: report.passed ? 'var(--up)' : 'var(--down)' }}>{report.passed ? 'every gate that applies passed' : 'a gate that applies failed'}</strong>.
            {report.twelveHour ? '' : ' The twelve-hour gates apply to a span of twelve hours or more.'} The stream, the alerts and the refusals reach back to when the app
            started, {clock(report.appStartedSec)}.
          </p>
          <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Gate', 'Result', 'Detail'].map((column) => (
                    <th key={column} style={headCellStyle}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.gates.map((gate) => {
                  const applies = !gate.twelveHour || report.twelveHour
                  return (
                    <tr key={gate.id}>
                      <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                        {gate.label}
                        {gate.twelveHour ? ' (12 h)' : ''}
                      </td>
                      <td style={statusStyle(gate, applies)}>{applies ? gate.status.toUpperCase() : 'NOT APPLIED'}</td>
                      <td style={{ ...cellStyle, whiteSpace: 'normal' }}>{gate.detail}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {figures(report).map((section) => (
            <div key={section.title} style={{ marginTop: '0.6rem' }}>
              <div style={{ ...noteStyle, fontWeight: 700, color: 'var(--text-primary)' }}>{section.title}</div>
              {section.lines.map((line) => (
                <p key={line} style={{ ...noteStyle, margin: '0.15rem 0 0' }}>
                  {line}
                </p>
              ))}
            </div>
          ))}
        </>
      )}
    </Card>
  )
}
