import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { BOOKS_REPORT_LINES, type BookId } from '../../shared/paperBooks'
import type { BookRunReport, BooksReport } from '../../shared/paperBooksReport'
import { msg, useI18n, type I18n } from '../i18n'
import { moveText } from './CameTrueCard'

// THE THREE BOOKS BESIDE THEIR BENCHMARKS (V8 Stage 10, 27 October 2026; V8-S9-BOOKS). The run of paper testing that
// runs or ran last, each book as its registration reads it (shared/paperBooksReport.ts): its closed trades' net in
// percent of their stake and in R, each with its 95% interval resampled by the day a trade closed; its equity's return;
// its benchmark over the same span -- cash for the news book, the leaders' own trades for the copy book, holding the
// eight symbols for the baseline -- and the difference's interval; Bitcoin as context only. No book is called
// profitable or better before 30 closed trades from 10 separate events. It reads; it places nothing.

const BOOK_NAMES: Record<BookId, string> = { news: msg('News book'), copy: msg('Copy book'), baseline: msg('Baseline') }

/** A mean in R with its interval, where one could be read: "+0.25R (-0.10R to +0.60R)". */
export function rText(figure: BookRunReport['meanR'], { t }: I18n): string {
  if (figure === null) return '—'
  const r = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`
  if (!Number.isFinite(figure.low) || !Number.isFinite(figure.high)) return r(figure.value)
  return t('{value} ({low} to {high})', { value: r(figure.value), low: r(figure.low), high: r(figure.high) })
}

/** The book's benchmark, in words, with its figure. */
export function benchmarkText(report: BookRunReport, { t, pct }: I18n): string {
  const { benchmark } = report
  if (benchmark.kind === 'cash') return t('cash: 0%')
  if (benchmark.kind === 'leader') {
    if (benchmark.pct === null) return t("the leaders' own trades: none compared yet")
    return t("the leaders' own trades: {pct} on {count} follows", { pct: pct(benchmark.pct, 2), count: benchmark.compared })
  }
  return benchmark.pct === null ? t('holding the eight symbols: not read') : t('holding the eight symbols: {pct}', { pct: pct(benchmark.pct, 2) })
}

/** What the book may be called, as V8-S9-BOOKS says. */
export function verdictText(report: BookRunReport, { t }: I18n): string {
  if (report.profitable === 'too few') {
    return t('too few to call: {trades} of {minTrades} closed trades, {events} of {minEvents} events', {
      trades: report.trades,
      minTrades: BOOKS_REPORT_LINES.minTrades,
      events: report.events,
      minEvents: BOOKS_REPORT_LINES.minEvents
    })
  }
  const profitable = report.profitable === 'yes' ? t('profitable') : t('not shown profitable')
  const better = report.better === 'yes' ? t('better than its benchmark') : t('not shown better than its benchmark')
  return t('{profitable}; {better}', { profitable, better })
}

export function BooksReportView({ report }: { report: BooksReport | null }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num, pct, utcDay, utcTime } = i18n
  const when = (sec: number): string => t('{time} UTC', { time: `${utcDay(sec * 1000)} ${utcTime(sec * 1000)}` })
  const first = report?.reports[0]
  return (
    <Card title={t('The three books against their benchmarks')}>
      <p style={noteStyle}>
        {t('Each book on its own $10,000 of paper money, judged as registered before the first Start: its closed trades after fees and funding, in percent of their stake and in R (a trade against its risk at entry), with 95% intervals resampled by day; and its benchmark over the same span. No book is called profitable, or better than its benchmark, before {trades} closed trades from {events} separate events.', {
          trades: BOOKS_REPORT_LINES.minTrades,
          events: BOOKS_REPORT_LINES.minEvents
        })}
      </p>
      {report === null ? (
        <p style={noteStyle}>{t('Reading the books…')}</p>
      ) : report.startedAt === null || first === undefined ? (
        <p style={noteStyle}>{t('Paper testing has not been started, so the books have no run to read. Start it on Paper Trading.')}</p>
      ) : (
        <>
          <p style={{ ...noteStyle, color: 'var(--text-primary)', marginTop: '0.5rem' }}>
            {report.running ? t('The run that began {start}, running.', { start: when(first.startedAt) }) : t('The run that began {start}, stopped {end}.', { start: when(first.startedAt), end: when(first.endedAt) })}{' '}
            {first.btcPct === null ? '' : t('Bitcoin moved {pct} over it: context, never a benchmark.', { pct: pct(first.btcPct, 2) })}
          </p>
          <div style={{ overflowX: 'auto', marginTop: '0.6rem' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>{t('Book')}</th>
                  <th style={headCellStyle}>{t('Closed trades')}</th>
                  <th style={headCellStyle}>{t('Events')}</th>
                  <th style={headCellStyle}>{t('Net per trade')}</th>
                  <th style={headCellStyle}>{t('Mean R')}</th>
                  <th style={headCellStyle}>{t('Equity')}</th>
                  <th style={headCellStyle}>{t('Benchmark')}</th>
                  <th style={headCellStyle}>{t('Less its benchmark')}</th>
                  <th style={headCellStyle}>{t('Verdict')}</th>
                </tr>
              </thead>
              <tbody>
                {report.reports.map((book) => (
                  <tr key={book.book}>
                    <td style={cellStyle}>{t(BOOK_NAMES[book.book])}</td>
                    <td style={cellStyle}>{num(book.trades)}</td>
                    <td style={cellStyle}>{num(book.events)}</td>
                    <td style={cellStyle}>{moveText(book.meanPct, i18n)}</td>
                    <td style={cellStyle}>{rText(book.meanR, i18n)}</td>
                    <td style={cellStyle}>{book.equityReturnPct === null ? '—' : pct(book.equityReturnPct, 2)}</td>
                    <td style={cellStyle}>{benchmarkText(book, i18n)}</td>
                    <td style={cellStyle}>{moveText(book.benchmark.difference, i18n)}</td>
                    <td style={cellStyle}>{verdictText(book, i18n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.reports.some((book) => book.noVenue > 0) && (
            <p style={noteStyle}>{t('{count} trades no venue could take, counted apart and called nothing.', { count: report.reports.reduce((sum, book) => sum + book.noVenue, 0) })}</p>
          )}
          {report.reports.some((book) => book.benchmark.notCompared > 0) && (
            <p style={noteStyle}>{t("{count} follows not set against their leader: the leader's position had not closed when the follow did, or its fills were not read.", { count: report.reports.reduce((sum, book) => sum + book.benchmark.notCompared, 0) })}</p>
          )}
        </>
      )}
    </Card>
  )
}

export function BooksReportCard(): React.JSX.Element {
  const [report, setReport] = useState<BooksReport | null>(null)
  useEffect(() => {
    let live = true
    void window.api.books
      .report()
      .then((read) => {
        if (live) setReport(read)
      })
      .catch(() => {
        if (live) setReport({ startedAt: null, running: false, reports: [] })
      })
    return (): void => {
      live = false
    }
  }, [])
  return <BooksReportView report={report} />
}
