import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'
import { BASELINE_LINES } from '../../shared/baseline'
import { NEWS_READER_FAILURES_TO_STOP } from '../../shared/news'
import type { BookId, BookStanding } from '../../shared/paperBooks'
import { PAPER_TESTING_SWITCHES, PAPER_TESTING_SWITCH_NAMES, type PaperTestingState } from '../../shared/paperTesting'
import { stopPaperTesting } from './paperTesting'

// PAPER TESTING, ON PAPER TRADING (V8 Stage 9, 27 October 2026; English until Stage 10). The three books' Start and
// Stop, each behind a confirmation on the card that names what it does: Start, every switch it turns on and what it
// uses as it is; Stop, the trades it closes and every switch it puts back. While the books run, each one's money, the
// announcement reader's health and what Start turned on. It reads, and starts or stops through the books' own channels
// (electron/services/paperTestingService.ts, src/trading/paperTesting.ts): it writes no setting and no trade itself.

const REFRESH_MS = 15_000

const BOOK_NAMES: Record<BookId, string> = { news: 'News book', copy: 'Copy book', baseline: 'Baseline' }

const money = (value: number | null): string => (value === null ? 'not priced' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const utc = (sec: number): string => `${new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`

function since(sec: number, nowSec: number): string {
  const minutes = Math.max(0, Math.floor((nowSec - sec) / 60))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} days ${hours % 24} h`
}

/** What the announcement reader is doing, in one sentence. */
export function readerLine(state: Pick<PaperTestingState, 'reader' | 'switches'>, nowSec: number): string {
  const { health, lastReadAt, error } = state.reader
  if (health.stoppedAt !== null) {
    return `Binance's announcements: the reader stopped itself at ${utc(health.stoppedAt)} after ${NEWS_READER_FAILURES_TO_STOP} reads in a row read nothing (${health.stoppedReason ?? 'no reason given'}). Switch it on again under Settings › Market.`
  }
  if (!state.switches['news.enabled']) return "Binance's announcements: not being read."
  if (lastReadAt === null) return "Binance's announcements: not read yet."
  const last = `Binance's announcements: last read ${since(lastReadAt, nowSec)} ago`
  if (error === null) return `${last}.`
  return health.failuresInRow > 0
    ? `${last}, reading nothing ${health.failuresInRow} time${health.failuresInRow === 1 ? '' : 's'} in a row (${error}); at ${NEWS_READER_FAILURES_TO_STOP} it stops itself.`
    : `${last}, in part (${error}).`
}

/** What Start's confirmation lists: each switch, turned on or already on; and what it uses as it is. */
export function startItems(state: Pick<PaperTestingState, 'switches' | 'tagShort' | 'follows' | 'clones'>): string[] {
  const symbols = BASELINE_LINES.symbols.map((symbol) => symbol.replace(/USDT$/, ''))
  return [
    ...PAPER_TESTING_SWITCHES.map((name) => `${PAPER_TESTING_SWITCH_NAMES[name]}: ${state.switches[name] ? 'already on' : 'switched on'}.`),
    state.tagShort ? "The Monitoring Tag's bracket short: on, and used in the news book." : "The Monitoring Tag's bracket short: off, and left off (Settings › Market switches it).",
    `Follows of the traders you follow on Copy Traders: ${state.follows}; clones run: ${state.clones}. They enter only positions opened from now.`,
    `The baseline: Trend Regime Ensemble on ${symbols.slice(0, -1).join(', ')} and ${symbols[symbols.length - 1]}, long on Binance's spot, at its 4-hour closes from the next one, on signals of its own after Start.`
  ]
}

/** What Stop's confirmation lists: each switch Start turned on, put back as it was. */
export function stopItems(state: Pick<PaperTestingState, 'started'>): string[] {
  const switched = state.started?.switched ?? []
  if (switched.length === 0) return ['No switch to put back: everything paper testing reads was already on at Start, and stays on.']
  return switched.map((entry) => `${PAPER_TESTING_SWITCH_NAMES[entry.switch]}: back ${entry.was ? 'on' : 'off'}.`)
}

function StandingsTable({ standings }: { standings: readonly BookStanding[] }): React.JSX.Element {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            {['Book', 'Equity', 'Settled', 'Open', 'Closed', "Day's start"].map((head) => (
              <th key={head} style={headCellStyle}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {standings.map((standing) => (
            <tr key={standing.id}>
              <td style={cellStyle}>{BOOK_NAMES[standing.id]}</td>
              <td style={cellStyle}>{money(standing.equity)}</td>
              <td style={cellStyle}>{money(standing.settledEquity)}</td>
              <td style={cellStyle}>{standing.open}</td>
              <td style={cellStyle}>{standing.closed}</td>
              <td style={cellStyle}>{money(standing.dayStartEquity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const confirmStyle: React.CSSProperties = {
  background: 'var(--bg-app)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: '0.7rem 0.75rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.45rem'
}

/** The card as drawn from a state: pure, so a test can draw it. */
export function PaperTestingView({
  state,
  nowSec,
  confirming,
  busy,
  problem,
  note,
  onAsk,
  onCancel,
  onStart,
  onStop
}: {
  state: PaperTestingState
  nowSec: number
  confirming: 'start' | 'stop' | null
  busy: boolean
  problem: string | null
  note: string | null
  onAsk: (what: 'start' | 'stop') => void
  onCancel: () => void
  onStart: () => void
  onStop: () => void
}): React.JSX.Element {
  const open = state.standings.reduce((sum, standing) => sum + standing.open, 0)
  const pendingStop = !state.running && state.started !== null
  return (
    <Card title="Paper testing">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <p style={noteStyle}>
          Three paper books side by side, each on its own $10,000: the news book (the delisting rule&rsquo;s shorts on each coin&rsquo;s perpetual), the copy book (the traders you follow and the clones you run) and the baseline (Trend Regime Ensemble on its eight symbols). Nothing real is placed. A book is called profitable only after 30 closed trades from 10 separate events.
        </p>
        {state.running && state.startedAt !== null && (
          <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>
            Running since {utc(state.startedAt)} ({since(state.startedAt, nowSec)}).
          </p>
        )}
        {!state.running && <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>{state.startedAt === null ? 'Not yet running.' : `Stopped. The last run began ${utc(state.startedAt)}; its books as it ended:`}</p>}
        {(state.running || state.startedAt !== null) && <StandingsTable standings={state.standings} />}
        {state.running && <p style={noteStyle}>{readerLine(state, nowSec)}</p>}
        {state.running && state.started !== null && (
          <p style={noteStyle}>
            {state.started.switched.length === 0 ? 'Start turned nothing on: everything it reads was already on.' : `Start turned on: ${state.started.switched.map((entry) => PAPER_TESTING_SWITCH_NAMES[entry.switch]).join('; ')}.`}
          </p>
        )}
        {pendingStop && <p style={{ ...noteStyle, color: 'var(--down)' }}>The last Stop could not put every switch back. Stop paper testing again.</p>}
        {confirming === null && (
          <div>
            {state.running || pendingStop ? (
              <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={() => onAsk('stop')}>
                Stop paper testing
              </button>
            ) : (
              <button type="button" style={buttonStyle('primary', busy)} disabled={busy} onClick={() => onAsk('start')}>
                Start paper testing
              </button>
            )}
          </div>
        )}
        {confirming === 'start' && (
          <div style={confirmStyle}>
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>Start paper testing?</span>
            {startItems(state).map((item) => (
              <span key={item} style={{ fontSize: '0.74rem', lineHeight: 1.45, color: 'var(--text-secondary)' }}>
                {item}
              </span>
            ))}
            <span style={{ fontSize: '0.74rem', lineHeight: 1.45, color: 'var(--text-secondary)' }}>Stop puts back each switch Start turned on, and closes the books&rsquo; open trades at the price then.</span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={onCancel}>
                Cancel
              </button>
              <button type="button" style={buttonStyle('primary', busy)} disabled={busy} onClick={onStart}>
                Start paper testing
              </button>
            </div>
          </div>
        )}
        {confirming === 'stop' && (
          <div style={confirmStyle}>
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>Stop paper testing?</span>
            <span style={{ fontSize: '0.74rem', lineHeight: 1.45, color: 'var(--text-secondary)' }}>
              {open === 0 ? 'No trade of the books is open.' : `The books' ${open} open trade${open === 1 ? '' : 's'} close${open === 1 ? 's' : ''} at the price then.`}
            </span>
            {stopItems(state).map((item) => (
              <span key={item} style={{ fontSize: '0.74rem', lineHeight: 1.45, color: 'var(--text-secondary)' }}>
                {item}
              </span>
            ))}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={onCancel}>
                Cancel
              </button>
              <button type="button" style={buttonStyle('primary', busy)} disabled={busy} onClick={onStop}>
                Stop paper testing
              </button>
            </div>
          </div>
        )}
        {note !== null && <p style={noteStyle}>{note}</p>}
        {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
      </div>
    </Card>
  )
}

export function PaperTestingCard(): React.JSX.Element | null {
  const [state, setState] = useState<PaperTestingState | null>(null)
  const [confirming, setConfirming] = useState<'start' | 'stop' | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))

  const refresh = useCallback(async (): Promise<void> => {
    setState(await window.api.books.testing())
    setNowSec(Math.floor(Date.now() / 1000))
  }, [])
  useEffect(() => {
    void refresh().catch((error) => setProblem(describeError(error)))
    const timer = setInterval(() => void refresh().catch(() => undefined), REFRESH_MS)
    return (): void => clearInterval(timer)
  }, [refresh])

  const press = async (run: () => Promise<string | null>): Promise<void> => {
    setBusy(true)
    setProblem(null)
    setNote(null)
    try {
      setNote(await run())
      setConfirming(null)
      await refresh()
    } catch (error) {
      setProblem(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  if (state === null) return problem === null ? null : <Card title="Paper testing"><p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p></Card>
  return (
    <PaperTestingView
      state={state}
      nowSec={nowSec}
      confirming={confirming}
      busy={busy}
      problem={problem}
      note={note}
      onAsk={(what) => {
        setProblem(null)
        setConfirming(what)
      }}
      onCancel={() => setConfirming(null)}
      onStart={() =>
        void press(async () => {
          await window.api.books.start()
          return 'Paper testing started.'
        })
      }
      onStop={() =>
        void press(async () => {
          const { closed } = await stopPaperTesting()
          return `Paper testing stopped${closed.length === 0 ? '' : `: ${closed.length} trade${closed.length === 1 ? '' : 's'} closed`}.`
        })
      }
    />
  )
}
