import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { AI_ADDITION_PROMPT_VERSIONS, DAILY_SUMMARY_MAX_CHARS, dailySummariesOf, type DailySummaryOnFile } from '../../shared/aiAdditions'
import { describeDecider } from '../../shared/aiPanel'
import { DAILY_REPORT_DAYS_BACK, dailyReportCsv, dailySummaryQuestionOf, daysBack, describeDailyReport, type DailyReport } from '../../shared/dailyReport'
import { describeMarketRegime } from '../../shared/marketResearch'
import { buttonStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'
import { buildDailyReport, dailyReportBrowserDeps } from './dailyReport'

const DAY = 86_400
const signed = (value: number | null, places = 2, unit = '%'): string => (value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(places)}${unit}`)

function utcClock(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** One UTC day as the records hold it (shared/dailyReport.ts): yesterday, or any day back thirty,
 * built on a click from the records and public candles, saved as JSON or CSV; and beside it the one
 * paragraph the fifth AI addition wrote about the day, where it has, or a button to ask for it.
 * Building reads; asking is billed unless the answer is already on file, and held to one a day. */
export function DailyReportCard(): React.JSX.Element {
  const [day, setDay] = useState<string>(() => daysBack(Math.floor(Date.now() / 1000), 1)[0])
  const [report, setReport] = useState<DailyReport | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [summaries, setSummaries] = useState<Record<string, DailySummaryOnFile>>({})
  const [asking, setAsking] = useState(false)
  const days = daysBack(Math.floor(Date.now() / 1000))

  // The summaries on file: the ledger's rows under the addition's prompt, by the day each is about.
  useEffect(() => {
    let cancelled = false
    void window.api.ai
      .listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.daily, sinceSec: Math.floor(Date.now() / 1000) - (DAILY_REPORT_DAYS_BACK + 1) * DAY, limit: 200 })
      .then((page) => {
        if (!cancelled) setSummaries(dailySummariesOf(page.rows))
      })
      .catch(() => undefined)
    return (): void => {
      cancelled = true
    }
  }, [])

  async function build(): Promise<void> {
    if (progress !== null) return
    setProgress('Reading…')
    setNote(null)
    try {
      setReport(await buildDailyReport(day, dailyReportBrowserDeps, { onProgress: setProgress }))
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      setProgress(null)
    }
  }

  async function save(format: 'json' | 'csv'): Promise<void> {
    if (report === null) return
    setNote(null)
    try {
      const outcome = await window.api.backtest.exportSave({
        defaultFileName: `daily-report-${report.day}.${format}`,
        content: format === 'json' ? JSON.stringify(report, null, 2) : dailyReportCsv(report),
        format
      })
      if (outcome.status === 'saved') setNote({ ok: true, text: `Saved to ${outcome.filePath}` })
      else if (outcome.status === 'error') setNote({ ok: false, text: `Could not save the file: ${outcome.message}` })
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    }
  }

  async function ask(): Promise<void> {
    if (report === null || asking) return
    setAsking(true)
    setNote(null)
    try {
      const result = await window.api.ai.summarizeDay({ day: report.day, question: dailySummaryQuestionOf(report) }, false)
      const outcome = result.outcome
      if (outcome === null) setNote({ ok: false, text: 'Nothing was asked.' })
      else if (outcome.status === 'answered') {
        setSummaries((held) => ({ ...held, [report.day]: { day: report.day, summary: outcome.answer, at: Math.floor(Date.now() / 1000), model: outcome.model } }))
        setNote({ ok: true, text: outcome.cached ? 'The paragraph was already on file; nothing was spent.' : `${describeDecider(outcome.model)} wrote the paragraph.` })
      } else setNote({ ok: false, text: outcome.reason })
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      setAsking(false)
    }
  }

  const summary = summaries[report?.day ?? day] ?? null
  const busy = progress !== null

  return (
    <Card title="Daily report">
      <p style={{ ...noteStyle, marginTop: 0 }}>
        One UTC day as the records hold it: the market at its end and its biggest movers, from public candles; the major news, from the feed&apos;s stories (kept a
        week); the app&apos;s own paper trades, the calls and the alerts, as the session report has them over the day; the models&apos; last {DAILY_REPORT_DAYS_BACK}{' '}
        days; and the risk condition. Built when asked for and stored nowhere. Beside it, one paragraph a model writes from these figures: asked once a day by itself
        after 00:05 UTC while the watch is on, or here, and held to one call a day. It recommends nothing.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <select aria-label="Day of the report" value={day} disabled={busy} onChange={(change) => setDay(change.target.value)} style={inputStyle()}>
          {days.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <button onClick={() => void build()} disabled={busy} style={buttonStyle('primary', busy)}>
          {progress ?? 'Build the report'}
        </button>
        <button onClick={() => void save('json')} disabled={report === null || busy} style={buttonStyle('secondary', report === null || busy)}>
          Save as JSON
        </button>
        <button onClick={() => void save('csv')} disabled={report === null || busy} style={buttonStyle('secondary', report === null || busy)}>
          Save as CSV
        </button>
      </div>
      {note !== null && <p style={{ ...noteStyle, color: note.ok ? 'var(--text-secondary)' : 'var(--down)', marginTop: '0.5rem' }}>{note.text}</p>}
      {report !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '0.9rem', fontSize: '0.82rem', lineHeight: 1.6 }}>
          <p style={{ margin: 0, color: 'var(--text-primary)' }}>
            <strong>{describeDailyReport(report)}</strong>
          </p>
          <p style={{ margin: 0 }}>
            <strong>Market.</strong> Bitcoin {signed(report.market.btcDayPct)}, ether {signed(report.market.ethDayPct)} over the day;{' '}
            {report.market.regime === null ? 'the regime could not be read' : `${describeMarketRegime(report.market.regime).word} at the day's end`}; breadth{' '}
            {report.market.breadthPct === null ? '—' : `${report.market.breadthPct.toFixed(0)}% of ${report.market.pairsRead} pairs rose`}. Up:{' '}
            {report.market.moversUp.length === 0 ? 'none' : report.market.moversUp.map((mover) => `${mover.symbol} ${signed(mover.dayPct)}`).join(', ')}. Down:{' '}
            {report.market.moversDown.length === 0 ? 'none' : report.market.moversDown.map((mover) => `${mover.symbol} ${signed(mover.dayPct)}`).join(', ')}.
          </p>
          <p style={{ margin: 0 }}>
            <strong>News.</strong>{' '}
            {!report.news.kept
              ? 'The day is older than the feed keeps its stories.'
              : report.news.major.length === 0
                ? `No story of high impact among the ${report.news.storiesRead} read that day.`
                : report.news.major.map((story) => `${story.source}: ${story.title} (${story.impact}${story.reactionH1Pct === null ? '' : `, ${signed(story.reactionH1Pct)} the hour after`})`).join(' · ')}
          </p>
          <p style={{ margin: 0 }}>
            <strong>Own paper trades.</strong> {report.session.paper.opened} opened, {report.session.paper.ended} ended, {report.session.paper.open} open now;{' '}
            {report.session.paper.net.length === 0 ? 'nothing made or lost' : report.session.paper.net.map((entry) => `${signed(entry.amount, 2, '')} ${entry.asset}`).join(', ')};{' '}
            {signed(report.session.paper.r, 2, ' R')} over {report.session.paper.rTrades} with a stop; best {signed(report.session.paper.bestPct)}, worst {signed(report.session.paper.worstPct)}.{' '}
            {report.session.calls.total} calls, {report.session.calls.valid} valid, ${report.session.calls.costUsd.toFixed(4)}.
            {report.session.paper.refused.length > 0 && ` Refused: ${report.session.paper.refused.map((entry) => `${entry.reason} (${entry.count})`).join('; ')}.`}
          </p>
          <p style={{ margin: 0 }}>
            <strong>Models, last {report.models.days} days.</strong>{' '}
            {report.models.rows.length === 0
              ? 'No model has a closed trade on its answers.'
              : report.models.rows
                  .map((row) => `${describeDecider(row.model)}: ${row.closed} closed, ${row.meanNetPct === null ? 'not enough' : `${signed(row.meanNetPct)} a trade`}${row.profitFactor === null ? '' : `, PF ${row.profitFactor.toFixed(2)}`}`)
                  .join(' · ')}
          </p>
          <p style={{ margin: 0 }}>
            <strong>Risk.</strong> Paper trades {report.risk.paused.watch || report.risk.paused.news ? `paused (${[report.risk.paused.watch ? 'the watch' : null, report.risk.paused.news ? 'the news rules' : null].filter(Boolean).join(', ')})` : 'not paused'}; AI spent $
            {report.risk.aiSpentUsd.toFixed(4)} of ${report.risk.aiCapUsd.toFixed(2)}; {report.risk.healthPauses} live-trading {report.risk.healthPauses === 1 ? 'pause' : 'pauses'} by the exchange&apos;s health;{' '}
            {report.risk.alertsHigh} high alerts. Gates: {report.session.passed ? 'every gate that applies passed' : 'a gate failed'}.
          </p>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
            <strong>The day in a paragraph.</strong>{' '}
            {summary === null ? (
              <>
                <span style={{ color: 'var(--text-secondary)' }}>None on file for {report.day}.</span>{' '}
                <button onClick={() => void ask()} disabled={asking || busy} style={buttonStyle('secondary', asking || busy)}>
                  {asking ? 'Asking…' : 'Ask for the paragraph'}
                </button>
              </>
            ) : (
              <span>
                {summary.summary.summary.slice(0, DAILY_SUMMARY_MAX_CHARS)}{' '}
                <span style={{ color: 'var(--text-muted)' }}>
                  ({describeDecider(summary.model)}, {utcClock(summary.at)}, confidence {Math.round(summary.summary.confidence * 100)}%)
                </span>
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}
