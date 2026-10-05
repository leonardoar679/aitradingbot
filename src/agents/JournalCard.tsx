import { useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { formatUsd } from '../../shared/aiCost'
import { AI_OPPORTUNITY_PROMPT_VERSION } from '../../shared/aiOpportunity'
import { describeOpportunityExit } from '../../shared/aiOpportunityOutcome'
import { describeDecider } from '../../shared/aiPanel'
import type { Candle } from '../../shared/ipc'
import { describeEventType } from '../../shared/marketEvent'
import { describeError } from '../utils/ipcError'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle, signedPct } from './agentStyles'
import { answerSources, filterJournal, journalCsv, journalRows, journalTotals, type JournalCall, type JournalRow } from './journal'
import { assembleFeed, loadFeedBars, type CandleFetch, type EventFeedItem } from './opportunities'
import { TradeTimeline } from './TradeTimeline'

const JOURNAL_DAYS = 30
/** Rows read from each file, newest first. */
const ROWS_READ = 5000
const ROWS_SHOWN = 100

const fetchCandles: CandleFetch = async (exchange, symbol, interval, startSec, endSec) =>
  (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles

const SOURCE_LABEL: Record<string, string> = { watch: 'the watch', opportunity: 'a click', benchmark: 'a benchmark' }
const CALLS: JournalCall[] = ['BUY', 'SELL', 'NO TRADE', 'REFUSED']

function utcMinute(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

function plainNumber(value: number): string {
  return Number(value.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 8 })
}

function daySec(value: string): number | undefined {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return value === '' || Number.isNaN(parsed) ? undefined : parsed / 1000
}

function describeStatus(row: JournalRow): string {
  if (row.status === 'closed') return row.exit === null ? 'closed' : describeOpportunityExit(row.exit)
  if (row.status === 'expired') return 'never filled'
  if (row.status === 'open') return 'in the trade'
  if (row.status === 'waiting') return 'waiting to enter'
  if (row.status === 'not scored') return 'not scored yet'
  if (row.status === 'not acted on') return 'under 65%'
  return '—'
}

/** Every recommendation on an event the scanner raised, with what it did (./journal.ts).
 *
 * OPENING THE TAB READS NOTHING FOR THIS CARD. "Load the journal" reads two files; "Score them"
 * reads public candles, one request for each event with a call to act on. Nothing here asks a
 * model, and nothing here trades: it lists, filters and saves a spreadsheet. `paper` is the
 * `eventId:model` of each answer the watch paper traded. */
export function JournalCard({ paper }: { paper: ReadonlySet<string> }): React.JSX.Element {
  const [feed, setFeed] = useState<EventFeedItem[] | null>(null)
  const [sources, setSources] = useState<ReturnType<typeof answerSources>>(new Map())
  const [bars, setBars] = useState<Map<string, Candle[]>>(new Map())
  const [scored, setScored] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [model, setModel] = useState('')
  const [symbol, setSymbol] = useState('')
  const [call, setCall] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [shown, setShown] = useState(ROWS_SHOWN)
  // The line whose whole story is open under the table, by event and model.
  const [opened, setOpened] = useState<{ eventId: string; model: string; title: string } | null>(null)
  const loadedAt = useRef(0)

  async function load(): Promise<void> {
    if (busy !== null) return
    setBusy('Reading the record of answers and events…')
    setNote(null)
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const sinceSec = nowSec - JOURNAL_DAYS * 86_400
      const [calls, events] = await Promise.all([
        window.api.ai.listCalls({ promptVersion: AI_OPPORTUNITY_PROMPT_VERSION, sinceSec, limit: ROWS_READ }),
        // An answer inside the period can be about an event raised a little before it began.
        window.api.scanner.listEvents({ sinceSec: sinceSec - 3600, limit: ROWS_READ })
      ])
      loadedAt.current = nowSec
      setSources(answerSources(calls.rows))
      // Only events with an answer make a line.
      setFeed(assembleFeed(events.rows, calls.rows).filter((item) => item.answers.length > 0))
      setBars(new Map())
      setScored(false)
      setShown(ROWS_SHOWN)
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      setBusy(null)
    }
  }

  async function score(): Promise<void> {
    if (feed === null || busy !== null) return
    setBusy('Reading what followed each event…')
    setNote(null)
    try {
      setBars(await loadFeedBars(feed, Math.floor(Date.now() / 1000), fetchCandles))
      setScored(true)
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    } finally {
      setBusy(null)
    }
  }

  const all = useMemo(() => (feed === null ? [] : journalRows(feed, bars, Math.floor(Date.now() / 1000), sources, paper)), [feed, bars, sources, paper])
  const toDay = daySec(to)
  const rows = useMemo(
    () =>
      filterJournal(all, {
        model: model === '' ? undefined : model,
        symbol,
        call: (CALLS as string[]).includes(call) ? (call as JournalCall) : undefined,
        fromSec: daySec(from),
        // A day named as the end is included whole.
        toSec: toDay === undefined ? undefined : toDay + 86_400
      }),
    [all, model, symbol, call, from, toDay]
  )
  const totals = journalTotals(rows)
  const models = [...new Set(all.map((row) => row.model))].sort()

  async function save(): Promise<void> {
    if (rows.length === 0 || busy !== null) return
    setNote(null)
    try {
      const outcome = await window.api.backtest.exportSave({
        defaultFileName: `recommendations-${new Date().toISOString().slice(0, 10)}.csv`,
        content: journalCsv(rows),
        format: 'csv'
      })
      if (outcome.status === 'saved') setNote({ ok: true, text: `Saved ${rows.length.toLocaleString()} lines to ${outcome.filePath}` })
      else if (outcome.status === 'error') setNote({ ok: false, text: `Could not save the file: ${outcome.message}` })
    } catch (failure) {
      setNote({ ok: false, text: describeError(failure) })
    }
  }

  const fieldStyle: React.CSSProperties = { fontSize: '0.8rem', color: 'var(--text-secondary)' }

  return (
    <Card title="Journal">
      <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => void load()} disabled={busy !== null} style={buttonStyle(feed === null ? 'primary' : 'secondary', busy !== null)}>
          {feed === null ? 'Load the journal' : 'Load again'}
        </button>
        {feed !== null && feed.length > 0 && (
          <button onClick={() => void score()} disabled={busy !== null} style={buttonStyle(scored ? 'secondary' : 'primary', busy !== null)}>
            {scored ? 'Score again' : 'Score them'}
          </button>
        )}
        {rows.length > 0 && (
          <button onClick={() => void save()} disabled={busy !== null} style={buttonStyle('secondary', busy !== null)}>
            Save as a spreadsheet
          </button>
        )}
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          {busy ??
            (feed === null
              ? ''
              : `${totals.rows.toLocaleString()} ${totals.rows === 1 ? 'recommendation' : 'recommendations'}${rows.length !== all.length ? ` of ${all.length.toLocaleString()}` : ''} in the last ${JOURNAL_DAYS} days.`)}
        </span>
      </div>
      {note !== null && <p style={{ ...noteStyle, color: note.ok ? 'var(--up)' : 'var(--down)', marginTop: '0.6rem' }}>{note.text}</p>}

      {feed !== null && all.length === 0 && <p style={{ ...noteStyle, marginTop: '0.7rem' }}>No model has answered an event the scanner raised in the last {JOURNAL_DAYS} days.</p>}

      {all.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.8rem' }}>
            <label style={fieldStyle}>
              Model{' '}
              <select aria-label="Journal model" value={model} onChange={(event) => setModel(event.target.value)} style={inputStyle()}>
                <option value="">all</option>
                {models.map((id) => (
                  <option key={id} value={id}>
                    {describeDecider(id)}
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldStyle}>
              Pair <input aria-label="Journal pair" value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="any" style={{ ...inputStyle(), width: 110 }} />
            </label>
            <label style={fieldStyle}>
              Call{' '}
              <select aria-label="Journal call" value={call} onChange={(event) => setCall(event.target.value)} style={inputStyle()}>
                <option value="">all</option>
                {CALLS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldStyle}>
              From <input aria-label="Journal from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} style={inputStyle()} />
            </label>
            <label style={fieldStyle}>
              to <input aria-label="Journal to" type="date" value={to} onChange={(event) => setTo(event.target.value)} style={inputStyle()} />
            </label>
          </div>

          <p style={{ ...noteStyle, color: 'var(--text-secondary)', marginTop: '0.7rem' }}>
            {totals.acted.toLocaleString()} at 65% confidence or more.{' '}
            {scored
              ? `${totals.closed.toLocaleString()} closed, ${totals.wins.toLocaleString()} of them ahead, ${signedPct(totals.netSumPct).text} added up after fees and slippage.`
              : 'What they did is not worked out until Score them is pressed.'}{' '}
            These answers cost {formatUsd(totals.costUsd)}.
          </p>

          <div style={{ overflowX: 'auto', marginTop: '0.6rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>Event (UTC)</th>
                  <th style={headCellStyle}>Pair</th>
                  <th style={headCellStyle}>Event</th>
                  <th style={headCellStyle}>Model</th>
                  <th style={headCellStyle}>Asked by</th>
                  <th style={headCellStyle}>Call</th>
                  <th style={headCellStyle}>Entry</th>
                  <th style={headCellStyle}>Stop / target</th>
                  <th style={headCellStyle}>What it did</th>
                  <th style={headCellStyle}>Net</th>
                  <th style={headCellStyle}>Paper</th>
                  <th style={headCellStyle}>Story</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((row) => {
                  const net = signedPct(row.netPct)
                  return (
                    <tr key={`${row.eventId}:${row.model}`}>
                      <td style={cellStyle}>{utcMinute(row.time)}</td>
                      <td style={{ ...cellStyle, fontWeight: 600 }}>{row.symbol}</td>
                      <td style={cellStyle}>
                        {describeEventType(row.eventType)} <span style={{ color: 'var(--text-muted)' }}>{row.score.toFixed(0)}</span>
                      </td>
                      <td style={cellStyle}>{describeDecider(row.model)}</td>
                      <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{row.source === null ? '—' : (SOURCE_LABEL[row.source] ?? row.source)}</td>
                      <td style={cellStyle}>
                        <span style={{ fontWeight: 700, color: row.call === 'BUY' ? 'var(--up)' : row.call === 'SELL' || row.call === 'REFUSED' ? 'var(--down)' : 'var(--text-secondary)' }}>{row.call}</span>
                        {row.call !== 'REFUSED' && <span style={{ color: 'var(--text-muted)' }}> {Math.round(row.confidence * 100)}%</span>}
                      </td>
                      <td style={cellStyle}>{row.entryMin === null || row.entryMax === null ? '—' : `${plainNumber(row.entryMin)} – ${plainNumber(row.entryMax)}`}</td>
                      <td style={cellStyle}>{row.stopLoss === null || row.takeProfit === null ? '—' : `${plainNumber(row.stopLoss)} / ${plainNumber(row.takeProfit)}`}</td>
                      <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>
                        {describeStatus(row)}
                        {row.heldMinutes !== null && <span style={{ color: 'var(--text-muted)' }}> · {row.heldMinutes} min</span>}
                      </td>
                      <td style={{ ...cellStyle, color: net.color, fontWeight: 600 }}>{row.netPct === null ? '—' : net.text}</td>
                      <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{row.paperTrade ? 'opened' : '—'}</td>
                      <td style={cellStyle}>
                        <button
                          onClick={() =>
                            setOpened((current) =>
                              current?.eventId === row.eventId && current.model === row.model
                                ? null
                                : { eventId: row.eventId, model: row.model, title: `${row.symbol}, ${describeDecider(row.model)}, ${utcMinute(row.time)} UTC` }
                            )
                          }
                          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}
                        >
                          {opened?.eventId === row.eventId && opened.model === row.model ? 'Hide' : 'Timeline'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {opened !== null && (
            <div style={{ marginTop: '0.8rem', borderTop: '1px solid var(--border)', paddingTop: '0.7rem' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.45rem' }}>The story of {opened.title}</div>
              <TradeTimeline key={`${opened.eventId}:${opened.model}`} eventId={opened.eventId} model={opened.model} />
            </div>
          )}
          {rows.length > shown && (
            <button onClick={() => setShown((count) => count + ROWS_SHOWN)} style={{ ...buttonStyle('secondary'), marginTop: '0.7rem' }}>
              Show {Math.min(ROWS_SHOWN, rows.length - shown)} more
            </button>
          )}
        </>
      )}

      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        One line for each answer a model gave about an event the scanner raised, whoever asked: the watch, a click on Ask, or a benchmark that happened to cover a live event. <strong>Load
        the journal</strong> reads the record of calls and the record of events. <strong>Score them</strong> reads the minute candles after each event with a call to act on, and follows the
        recommendation to the letter, as its card does. The spreadsheet holds the lines the filters leave, with every level and time. Nothing here is stored: it is worked out again each
        time.
      </p>
    </Card>
  )
}
