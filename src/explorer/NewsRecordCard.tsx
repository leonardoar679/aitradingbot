import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import {
  NEWS_RECORD_KIND_LABEL,
  NEWS_RECORD_RULES,
  NEWS_RECORD_RULE_ORDER,
  summariseNewsRecord,
  type NewsRecord,
  type NewsRecordRow,
  type NewsRecordRule
} from '../../shared/newsRecord'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'

const PASSED = NEWS_RECORD_RULE_ORDER.filter((rule) => NEWS_RECORD_RULES[rule].passed)
const NEAR_MISSES = NEWS_RECORD_RULE_ORDER.filter((rule) => !NEWS_RECORD_RULES[rule].passed)
const SHOWN = 40

function utcDay(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

function signedPct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function resultCell(row: NewsRecordRow): React.JSX.Element {
  if (row.status === 'scored' && row.netPct !== null) {
    return <span style={{ fontWeight: 600, color: row.netPct > 0 ? 'var(--up)' : 'var(--down)' }}>{signedPct(row.netPct)}</span>
  }
  if (row.status === 'waiting') return <span style={{ color: 'var(--text-muted)' }}>Its trade is not over yet</span>
  return <span style={{ color: 'var(--text-muted)' }}>{row.note ?? 'Not scored.'}</span>
}

function SummaryLine({ rows, rule }: { rows: NewsRecordRow[]; rule: NewsRecordRule }): React.JSX.Element {
  const summary = summariseNewsRecord(rows, rule)
  const info = NEWS_RECORD_RULES[rule]
  const pending = [summary.waiting > 0 ? `${summary.waiting} not over yet` : '', summary.unscored > 0 ? `${summary.unscored} not scored` : ''].filter((part) => part !== '').join(', ')
  return (
    <p style={{ ...noteStyle, margin: 0, color: 'var(--text-primary)' }}>
      <strong>{NEWS_RECORD_KIND_LABEL[info.category]}</strong>, {info.rule}:{' '}
      {summary.scored === 0 || summary.meanPct === null
        ? 'none scored yet'
        : `${summary.scored} ${summary.scored === 1 ? 'coin' : 'coins'}, ${signedPct(summary.meanPct)} a coin on average, ${summary.ahead} ahead, worst ${signedPct(summary.worstPct ?? 0)}`}
      {pending !== '' && ` (${pending})`}.{' '}
      <span style={{ color: 'var(--text-secondary)' }}>
        In the study: {signedPct(info.study.meanPct)} a coin, {info.study.ahead} of {info.study.of} ahead.
      </span>
    </p>
  )
}

/** What the two news rules research/NEWS.md found paid would have made since the study ended, and
 * the two trades that came nearest without passing (research/NEWS.md, research/UPBIT.md), as the
 * main process scores them (electron/services/newsRecordService.ts) on each coin's own candles,
 * whether or not this app's paper short was on. Read and shown only: it opens nothing and asks no
 * model. Reading it reads Binance's and Upbit's public lists and Binance's candles, so it is read
 * when this card is shown and when it is asked to look again. */
export function NewsRecordCard(): React.JSX.Element {
  const [record, setRecord] = useState<NewsRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const read = useCallback(async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      setRecord(await window.api.news.record())
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  const rows = record?.rows ?? []
  const since = record === null ? '1 October 2026' : new Date(record.since * 1000).toISOString().slice(0, 10)

  return (
    <Card title="The news rules since the study">
      <p style={{ ...noteStyle, marginTop: 0 }}>
        Every delisting and every coin added to the Monitoring Tag Binance has announced since {since}, scored as its rule trades it, on the
        coin&apos;s own 1-minute candles: whether or not the paper short was on, or this app was open. Short, after 0.1% fees and 0.1% slippage
        a side, by the arithmetic the study used. It is a record of what the rules would have made, not a signal: nothing is opened because of
        it.
      </p>
      {(problem ?? record?.error) && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.5rem' }}>{problem ?? record?.error}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.7rem' }}>
        {PASSED.map((rule) => (
          <SummaryLine key={rule} rows={rows} rule={rule} />
        ))}
      </div>

      <p style={{ ...noteStyle, marginTop: '0.8rem', marginBottom: 0 }}>
        <strong>Two near misses, on record the same way.</strong> A coin Binance adds to the Monitoring Tag, and one Upbit designates for
        caution, each held short four hours on its Binance pair. Both started a slow fall in the studies and missed the bar they were held to;
        this shows whether the fall goes on. Nothing in the app acts on either.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.4rem' }}>
        {NEAR_MISSES.map((rule) => (
          <SummaryLine key={rule} rows={rows} rule={rule} />
        ))}
      </div>

      {rows.length === 0 ? (
        <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
          {record === null
            ? 'Reading the lists…'
            : `Since ${since}, Binance has announced no delisting and added no coin to the Monitoring Tag, and Upbit has designated no coin for caution.`}
        </p>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: '0.8rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>Released (UTC)</th>
                <th style={headCellStyle}>Kind</th>
                <th style={headCellStyle}>Coin</th>
                <th style={headCellStyle}>Trade</th>
                <th style={headCellStyle}>The short</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, SHOWN).map((row) => (
                <tr key={row.key} title={row.title}>
                  <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{utcDay(row.releaseSec)}</td>
                  <td style={{ ...cellStyle, whiteSpace: 'nowrap', color: 'var(--down)', fontWeight: 600 }}>{NEWS_RECORD_KIND_LABEL[row.category]}</td>
                  <td style={{ ...cellStyle, fontWeight: 600 }}>{row.symbol ?? row.ticker}</td>
                  <td style={cellStyle}>
                    {NEWS_RECORD_RULES[row.rule].rule}
                    {!NEWS_RECORD_RULES[row.rule].passed && <span style={{ color: 'var(--text-muted)' }}> (near miss)</span>}
                  </td>
                  <td style={cellStyle}>{resultCell(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap', marginTop: '0.8rem' }}>
        <button onClick={() => void read()} disabled={busy} style={buttonStyle('secondary', busy)}>
          {busy ? 'Reading…' : 'Look again'}
        </button>
        <span style={noteStyle}>
          A score is kept once made: a delisted coin&apos;s candles are soon gone from Binance. One that could not be scored is tried again on the
          next look. An Upbit coin is scored on the Binance pair of the same ticker. Lists are read at most once in ten minutes
          {record?.listedAt != null ? `; last at ${new Date(record.listedAt * 1000).toISOString().slice(11, 16)} UTC` : ''}.
        </span>
      </div>
    </Card>
  )
}
