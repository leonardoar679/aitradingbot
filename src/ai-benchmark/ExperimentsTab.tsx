import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { describeExperimentKind, describeExperimentVerdict, experimentStatusAt, EXPERIMENT_MAX_MINUTES, EXPERIMENT_MIN_MINUTES, type ExperimentKind, type ExperimentRun } from '../../shared/experimentRun'
import { sessionReportCsv } from '../../shared/shadowReport'
import { describeDecider } from '../../shared/aiPanel'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { inR, pct } from '../agents/EventTables'
import type { ForecastRunSection } from '../../shared/forecast/runSection'
import type { LabMetrics } from '../../shared/forecast/lab'

const stamp = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
const money = (value: number, digits = 2): string => `${value >= 0 ? '' : '-'}${Math.abs(value).toFixed(digits)}`
const STATUS_TONE: Record<ExperimentRun['status'], string> = { running: 'var(--gold)', ended: 'var(--text-primary)', reported: 'var(--up)', stopped: 'var(--text-muted)' }
const HORIZON_WORDS: Record<string, string> = { minutes5: '5 min', minutes15: '15 min', hour1: '1 hour', hours4: '4 hours', hours24: '24 hours' }
const share = (value: number | null): string => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)
const pctOf = (value: number | null): string => (value === null ? '—' : `${value.toFixed(3)}%`)
const outOf = (right: number, of: number): string => (of === 0 ? 'none called' : `${right} of ${of}`)
const inRange = (metrics: LabMetrics): string => (metrics.n === 0 ? 'none' : `${metrics.n}, ${share(metrics.coverage80)} in 80%`)

/** The forecast's lines of the run as a spreadsheet's (V6 Stage 15). */
function forecastCsvLines(section: ForecastRunSection, quote: (value: string | number | null) => string): string[] {
  const { predictions, trades } = section
  const lines = [['forecast', 'forecasts', predictions.lines, `${predictions.pairs} pairs, at ${predictions.gridCloses} of ${predictions.expectedGridCloses} quarter-hour closes, ${predictions.refreshes} refreshes`].map(quote).join(',')]
  for (const [horizon, row] of Object.entries(section.horizons)) {
    if (row === undefined) continue
    const m = row.metrics
    lines.push(['forecast horizon', HORIZON_WORDS[horizon] ?? horizon, row.outcomes, `direction ${share(m.direction)}; in 50% ${share(m.coverage50)}; in 80% ${share(m.coverage80)}; median error ${pctOf(m.mae)}; bias ${pctOf(m.bias)}; bull ${outOf(row.bull.right, row.bull.calls)}; bear ${outOf(row.bear.right, row.bear.calls)}; story-moved ${inRange(row.news.moved)}; the rest ${inRange(row.news.unmoved)}`].map(quote).join(','))
  }
  for (const [horizon, row] of Object.entries(section.horizons)) {
    if (row === undefined || row.variants === undefined) continue
    for (const [variant, m] of Object.entries(row.variants)) lines.push(['forecast variant', `${HORIZON_WORDS[horizon] ?? horizon} ${variant.toUpperCase()}`, m.n, `in 80% ${share(m.coverage80)}; median error ${pctOf(m.mae)}; way right ${share(m.direction)}`].map(quote).join(','))
  }
  for (const [call, count] of Object.entries(section.classes?.calls ?? {})) lines.push(['forecast calls', call, count, 'at the lead horizon'].map(quote).join(','))
  for (const [list, rows] of [['best rated', section.top ?? []], ['best called', section.best ?? []], ['worst called', section.worst ?? []]] as const) {
    for (const row of rows) lines.push([`forecast ${list}`, `${row.pair} ${stamp(row.t)}`, row.quality ?? '', `${HORIZON_WORDS[row.horizon] ?? row.horizon} ${row.call}, median ${pctOf(row.medianPct)}, moved ${pctOf(row.movePct)}`].map(quote).join(','))
  }
  for (const gate of section.gates) lines.push(['forecast gate', gate.label, gate.status.toUpperCase(), gate.detail].map(quote).join(','))
  lines.push(['forecast trader', 'paper trades', trades.closed, `${trades.opened} opened, ${trades.closed} closed, ${trades.wins} ahead, net ${trades.netQuote.toFixed(2)}, fees ${(trades.feesQuote ?? 0).toFixed(2)}, slippage ${(trades.slippageQuote ?? 0).toFixed(3)}`].map(quote).join(','))
  if (section.sampleNote !== null) lines.push(['forecast trader', 'note', '', section.sampleNote].map(quote).join(','))
  return lines
}

/** The price forecast over the run: what it made, and how each horizon came out (V6 Stage 15). */
function ForecastSectionView({ section }: { section: ForecastRunSection }): React.JSX.Element {
  const { predictions, trades } = section
  const reasons = Object.entries(predictions.byReason).map(([reason, count]) => `${reason} ${count}`).join(', ')
  const rows = Object.entries(section.horizons).filter((entry): entry is [string, NonNullable<ForecastRunSection['horizons'][keyof ForecastRunSection['horizons']]>] => entry[1] !== undefined)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <p style={{ margin: 0, fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>The price forecast</p>
      <p style={noteStyle}>
        {predictions.lines} forecasts of {predictions.pairs} pairs on record, at {predictions.gridCloses} of the span&apos;s {predictions.expectedGridCloses} quarter-hour closes; {predictions.refreshes} made again between closes
        {reasons === '' ? '' : ` (${reasons})`}.
      </p>
      {rows.length === 0 ? (
        <p style={noteStyle}>No forecast of the span has come due yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Horizon', 'Judged', 'Way right', 'In 50%', 'In 80%', 'Median error', 'Bias', 'BULLISH right', 'BEARISH right', 'Story-moved', 'The rest'].map((column) => (
                  <th key={column} style={headCellStyle}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([horizon, row]) => (
                <tr key={horizon}>
                  <td style={cellStyle}>{HORIZON_WORDS[horizon] ?? horizon}</td>
                  <td style={cellStyle}>{row.outcomes}</td>
                  <td style={cellStyle}>{share(row.metrics.direction)}</td>
                  <td style={cellStyle}>{share(row.metrics.coverage50)}</td>
                  <td style={cellStyle}>{share(row.metrics.coverage80)}</td>
                  <td style={cellStyle}>{pctOf(row.metrics.mae)}</td>
                  <td style={cellStyle}>{pctOf(row.metrics.bias)}</td>
                  <td style={cellStyle}>{outOf(row.bull.right, row.bull.calls)}</td>
                  <td style={cellStyle}>{outOf(row.bear.right, row.bear.calls)}</td>
                  <td style={cellStyle}>{inRange(row.news.moved)}</td>
                  <td style={cellStyle}>{inRange(row.news.unmoved)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {section.classes !== undefined && (
        <p style={noteStyle}>
          Their calls at the lead horizon: {Object.entries(section.classes.calls).map(([call, count]) => `${call} ${count}`).join(', ') || 'none'}; by the coin&apos;s class: {Object.entries(section.classes.pairClasses).map(([cls, count]) => `${cls} ${count}`).join(', ') || 'none'}.
        </p>
      )}
      {rows.some(([, row]) => row.variants !== undefined) && (
        <p style={noteStyle}>
          The four variants on the same moments, in 80% and the median&apos;s error: {rows
            .filter(([, row]) => row.variants !== undefined)
            .map(([horizon, row]) => `${HORIZON_WORDS[horizon] ?? horizon}: ${Object.entries(row.variants).map(([variant, m]) => `${variant.toUpperCase()} ${share(m.coverage80)} ${pctOf(m.mae)}`).join(' · ')}`)
            .join('; ')}
          .
        </p>
      )}
      {(section.best ?? []).length > 0 && (
        <p style={noteStyle}>
          Best called: {section.best.map((row) => `${row.pair} at ${stamp(row.t)} (median ${pctOf(row.medianPct)}, moved ${pctOf(row.movePct)})`).join('; ')}. Worst called:{' '}
          {section.worst.map((row) => `${row.pair} at ${stamp(row.t)} (median ${pctOf(row.medianPct)}, moved ${pctOf(row.movePct)})`).join('; ')}.
        </p>
      )}
      <p style={noteStyle}>
        The forecast trader: {trades.opened} paper trades opened, {trades.closed} closed, {trades.wins} of them ahead, net {money(trades.netQuote)} after fees of {money(trades.feesQuote ?? 0)} and slippage of {money(trades.slippageQuote ?? 0, 3)}.
        {section.sampleNote === null ? '' : ` ${section.sampleNote}`}
      </p>
    </div>
  )
}

/** The run as a spreadsheet: the session report's lines, then the run's own gates, figures and verdict. */
function experimentCsv(run: ExperimentRun): string {
  const report = run.report
  if (report === undefined) return ''
  const quote = (value: string | number | null): string => {
    const text = value === null ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [sessionReportCsv(report.session).trimEnd()]
  lines.push(['run', 'id', run.id, `${run.kind}, ${run.minutes} minutes, ${run.mode}`].map(quote).join(','))
  for (const gate of report.gates) lines.push(['experiment gate', gate.label, gate.status.toUpperCase(), gate.detail].map(quote).join(','))
  lines.push(['costs', 'fees', report.costs.feesQuote, 'in the quote'].map(quote).join(','))
  lines.push(['costs', 'slippage', report.costs.slippageQuote, 'in the quote, as the engine charged it'].map(quote).join(','))
  lines.push(['costs', 'ai', report.costs.aiUsd, 'dollars, every call in the span'].map(quote).join(','))
  for (const [key, value] of Object.entries(report.figures)) lines.push(['verdict figure', key, value, ''].map(quote).join(','))
  lines.push(['verdict', 'AI adding value', report.verdict, describeExperimentVerdict(report.verdict, report.figures)].map(quote).join(','))
  if (report.forecast !== undefined) lines.push(...forecastCsvLines(report.forecast, quote))
  for (const entry of report.help) {
    for (const row of entry.rows) lines.push(['does AI help', `${entry.model}: ${row.label}`, row.row.meanNetPct, `${row.row.closed} closed, ${row.row.wins} won`].map(quote).join(','))
    for (const verdict of entry.verdicts) lines.push(['does AI help', `${entry.model}: ${verdict.question}`, verdict.answer, verdict.text].map(quote).join(','))
  }
  return lines.join('\n') + '\n'
}

function ReportView({ run }: { run: ExperimentRun }): React.JSX.Element {
  const report = run.report
  const [note, setNote] = useState<string | null>(null)
  if (report === undefined) return <p style={noteStyle}>No report yet.</p>
  const save = async (format: 'json' | 'csv'): Promise<void> => {
    setNote(null)
    try {
      const outcome = await window.api.backtest.exportSave({
        defaultFileName: `experiment-${run.id}.${format}`,
        content: format === 'json' ? JSON.stringify(run, null, 2) : experimentCsv(run),
        format
      })
      setNote(outcome.status === 'saved' ? `Saved to ${outcome.filePath}` : 'Not saved.')
    } catch (failure) {
      setNote(`Could not save: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
  }
  const { session } = report
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
      <p style={{ margin: 0, fontSize: '0.82rem', color: report.passed ? 'var(--up)' : 'var(--down)', fontWeight: 700 }}>
        {report.passed ? 'Every gate that applies passed.' : 'A gate failed.'} {describeExperimentVerdict(report.verdict, report.figures)}
      </p>
      <p style={noteStyle}>
        From {stamp(session.fromSec)} to {stamp(session.toSec)} UTC, {run.mode}, under configuration {run.versions.config}, engine {run.versions.engine}, detector {run.versions.detector}, prompt{' '}
        {run.versions.prompt}; {run.models.length === 0 ? 'the watch off' : run.models.map((model) => describeDecider(model)).join(', ')}; a universe of {run.universe}.
      </p>
      <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        Events {session.events.raised} raised, {session.events.urgent} urgent, {session.events.takenUp} taken up. Calls {session.calls.total}, {session.calls.answered} answered, {session.calls.valid} valid, $
        {session.calls.costUsd.toFixed(4)}. Paper trades {session.paper.opened} opened, {session.paper.ended} ended, {session.paper.open} open, {session.paper.missed} missed; net{' '}
        {session.paper.net.map((entry) => `${money(entry.amount)} ${entry.asset}`).join(', ') || '0'} after fees of {money(report.costs.feesQuote)}, slippage {money(report.costs.slippageQuote, 3)}, the answers $
        {report.costs.aiUsd.toFixed(4)}.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Gate', 'Status', 'Detail'].map((column) => (
                <th key={column} style={headCellStyle}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ...session.gates.map((gate) => ({ label: gate.label, status: gate.status, detail: gate.detail })),
              ...report.gates.map((gate) => ({ label: gate.label, status: gate.status, detail: gate.detail })),
              ...(report.forecast?.gates ?? []).map((gate) => ({ label: gate.label, status: gate.status, detail: gate.detail }))
            ].map((gate) => (
              <tr key={gate.label}>
                <td style={cellStyle}>{gate.label}</td>
                <td style={{ ...cellStyle, fontWeight: 700, color: gate.status === 'pass' ? 'var(--up)' : gate.status === 'fail' ? 'var(--down)' : 'var(--text-muted)' }}>{gate.status.toUpperCase()}</td>
                <td style={{ ...cellStyle, whiteSpace: 'normal' }}>{gate.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.forecast !== undefined && <ForecastSectionView section={report.forecast} />}
      {report.help.length === 0 ? (
        <p style={noteStyle}>Does AI help? Nothing could be scored over the span: no event the watch answered, or no candles yet.</p>
      ) : (
        report.help.map((entry) => (
          <div key={entry.model} style={{ overflowX: 'auto' }}>
            <p style={{ margin: '0 0 0.3rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>Does AI help? {describeDecider(entry.model)}</p>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Row', 'Closed', 'Won', 'A trade', 'R a trade', 'Deepest fall'].map((column) => (
                    <th key={column} style={headCellStyle}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entry.rows.map(({ label, row }) => (
                  <tr key={label}>
                    <td style={cellStyle}>{label}</td>
                    <td style={cellStyle}>{row.closed}</td>
                    <td style={cellStyle}>{row.wins}</td>
                    <td style={cellStyle}>{pct(row.meanNetPct)}</td>
                    <td style={cellStyle}>{row.meanR === null ? '—' : inR(row.meanR)}</td>
                    <td style={cellStyle}>{pct(-row.maxDrawdownPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {entry.verdicts.map((verdict) => (
              <p key={verdict.id} style={{ ...noteStyle, marginTop: '0.3rem' }}>
                {verdict.question} {verdict.text}
              </p>
            ))}
          </div>
        ))
      )}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => void save('json')} style={buttonStyle('secondary')}>
          Save as JSON
        </button>
        <button onClick={() => void save('csv')} style={buttonStyle('secondary')}>
          Save as CSV
        </button>
        {note !== null && <span style={noteStyle}>{note}</span>}
      </div>
    </div>
  )
}

/** The runs the app keeps of itself (the V5 document, §56-62; shared/experimentRun.ts): one hour or
 * twelve, or a length of your own, started here and reported here when it ends. A run changes
 * nothing about how the app runs: it writes down what the app is as it starts and what it did by
 * the end. Nothing here asks a model or trades. */
export function ExperimentsTab(): React.JSX.Element {
  const [runs, setRuns] = useState<ExperimentRun[]>([])
  const [custom, setCustom] = useState('180')
  const [opened, setOpened] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000))

  const reload = async (): Promise<void> => {
    try {
      setRuns((await window.api.experiments.list()).rows)
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure))
    }
  }
  useEffect(() => {
    void reload()
    const unsubscribe = window.api.experiments.onUpdate(() => void reload())
    const clock = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 15_000)
    return (): void => {
      unsubscribe()
      window.clearInterval(clock)
    }
  }, [])

  const start = async (kind: ExperimentKind): Promise<void> => {
    setProblem(null)
    try {
      await window.api.experiments.start({ kind, minutes: kind === 'custom' ? Number(custom) : null })
      await reload()
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(failure))
    }
  }
  const stop = async (id: string): Promise<void> => {
    setProblem(null)
    try {
      await window.api.experiments.stop(id)
      await reload()
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure))
    }
  }
  const running = runs.find((run) => experimentStatusAt(run, nowSec) === 'running') ?? null
  const shown = opened === null ? null : (runs.find((run) => run.id === opened) ?? null)

  return (
    <>
      <Card title="New experiment">
        <p style={noteStyle}>
          A run writes down what the app is as it starts -- the mode, the versions, the models, the universe -- and, when it ends, what it did: the session report over its span with the
          document&apos;s gates, &quot;Does AI help?&quot; over its events, the costs, and whether AI is adding value by the pinned lines. It changes nothing about how the app runs, and asks
          nothing itself.
        </p>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          <button onClick={() => void start('shadow-1h')} disabled={running !== null} style={buttonStyle('primary', running !== null)}>
            One hour
          </button>
          <button onClick={() => void start('paper-12h')} disabled={running !== null} style={buttonStyle('primary', running !== null)}>
            Twelve hours
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Minutes
            <input type="number" min={EXPERIMENT_MIN_MINUTES} max={EXPERIMENT_MAX_MINUTES} value={custom} onChange={(change) => setCustom(change.target.value)} style={{ ...inputStyle(), width: 90 }} />
          </label>
          <button onClick={() => void start('custom')} disabled={running !== null} style={buttonStyle('secondary', running !== null)}>
            Start
          </button>
          {running !== null && (
            <span style={noteStyle}>
              {running.id} runs until {stamp(running.endsAt)} UTC.{' '}
              <button onClick={() => void stop(running.id)} style={{ ...buttonStyle('secondary'), padding: '0.15rem 0.5rem', fontSize: '0.72rem' }}>
                Stop it
              </button>
            </span>
          )}
          {problem !== null && <span style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</span>}
        </div>
      </Card>

      <Card title="Runs">
        {runs.length === 0 ? (
          <p style={noteStyle}>No run yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="experiment-runs">
              <thead>
                <tr>
                  {['', 'Run', 'Length', 'Started (UTC)', 'Ends (UTC)', 'Mode', 'Status', 'Versions', 'Models', 'Universe', 'Verdict'].map((column, index) => (
                    <th key={index} style={headCellStyle}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const status = experimentStatusAt(run, nowSec)
                  return (
                    <tr key={run.id}>
                      <td style={cellStyle}>
                        <button onClick={() => setOpened(opened === run.id ? null : run.id)} style={buttonStyle('secondary')} disabled={run.report === undefined}>
                          {opened === run.id ? 'Close' : 'Open'}
                        </button>
                      </td>
                      <td style={{ ...cellStyle, fontWeight: 600 }}>{run.id}</td>
                      <td style={cellStyle}>{describeExperimentKind(run.kind, run.minutes)}</td>
                      <td style={cellStyle}>{stamp(run.startedAt)}</td>
                      <td style={cellStyle}>{stamp(run.stoppedAt ?? run.endsAt)}</td>
                      <td style={cellStyle}>{run.mode}</td>
                      <td style={{ ...cellStyle, fontWeight: 700, color: STATUS_TONE[status] }} data-testid="experiment-status">
                        {status.toUpperCase()}
                      </td>
                      <td style={{ ...cellStyle, whiteSpace: 'normal', fontSize: '0.72rem' }}>
                        config {run.versions.config} · engine {run.versions.engine} · {run.versions.detector} · {run.versions.prompt}
                      </td>
                      <td style={{ ...cellStyle, whiteSpace: 'normal' }}>{run.models.length === 0 ? 'the watch off' : run.models.map((model) => describeDecider(model)).join(', ')}</td>
                      <td style={cellStyle}>{run.universe}</td>
                      <td style={{ ...cellStyle, fontWeight: 700, color: run.report === undefined ? 'var(--text-muted)' : run.report.verdict === 'YES' ? 'var(--up)' : 'var(--text-primary)' }} data-testid="experiment-verdict">
                        {run.report === undefined ? '—' : run.report.verdict}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {shown !== null && (
        <Card title={`Report: ${shown.id}`}>
          <ReportView run={shown} />
        </Card>
      )}
    </>
  )
}
