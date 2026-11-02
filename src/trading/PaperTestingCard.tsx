import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'
import { BASELINE_LINES } from '../../shared/baseline'
import { NEWS_READER_FAILURES_TO_STOP } from '../../shared/news'
import type { BookId, BookStanding } from '../../shared/paperBooks'
import { PAPER_TESTING_SWITCHES, PAPER_TESTING_SWITCH_NAMES, type PaperTestingState } from '../../shared/paperTesting'
import { msg, useI18n, type I18n } from '../i18n'
import { durationOf, utcWhen } from '../traders/traderText'
import { stopPaperTesting } from './paperTesting'

// PAPER TESTING, ON PAPER TRADING (V8 Stage 9, 27 October 2026; in ten languages since Stage 10). The three books'
// Start and Stop, each behind a confirmation on the card that names what it does: Start, every switch it turns on and
// what it uses as it is; Stop, the trades it closes and every switch it puts back. While the books run, each one's
// money, the announcement reader's health and what Start turned on. It reads, and starts or stops through the books'
// own channels (electron/services/paperTestingService.ts, src/trading/paperTesting.ts): it writes no setting and no
// trade itself. Home's tile opens Start's confirmation here (`askStart`).

const REFRESH_MS = 15_000

const BOOK_NAMES: Record<BookId, string> = { news: msg('News book'), copy: msg('Copy book'), baseline: msg('Baseline') }

const since = (i18n: I18n, sec: number, nowSec: number): string => durationOf(i18n, Math.max(0, (nowSec - sec) / 60))

/** What the announcement reader is doing, in one sentence. */
export function readerLine(state: Pick<PaperTestingState, 'reader' | 'switches'>, nowSec: number, i18n: I18n): string {
  const { t } = i18n
  const { health, lastReadAt, error } = state.reader
  if (health.stoppedAt !== null) {
    return t("Binance's announcements: the reader stopped itself at {time} after {count} reads in a row read nothing ({reason}). Switch it on again under Settings › Market.", {
      time: utcWhen(i18n, health.stoppedAt * 1000),
      count: NEWS_READER_FAILURES_TO_STOP,
      reason: health.stoppedReason ?? t('no reason given')
    })
  }
  if (!state.switches['news.enabled']) return t("Binance's announcements: not being read.")
  if (lastReadAt === null) return t("Binance's announcements: not read yet.")
  const ago = since(i18n, lastReadAt, nowSec)
  if (error === null) return t("Binance's announcements: last read {ago} ago.", { ago })
  return health.failuresInRow > 0
    ? t("Binance's announcements: last read {ago} ago, reading nothing {count} times in a row ({error}); at {stop} it stops itself.", { ago, count: health.failuresInRow, error, stop: NEWS_READER_FAILURES_TO_STOP })
    : t("Binance's announcements: last read {ago} ago, in part ({error}).", { ago, error })
}

/** What Start's confirmation lists: each switch, turned on or already on; and what it uses as it is. */
export function startItems(state: Pick<PaperTestingState, 'switches' | 'tagShort' | 'follows' | 'clones'>, i18n: I18n): string[] {
  const { t, num, list } = i18n
  const symbols = BASELINE_LINES.symbols.map((symbol) => symbol.replace(/USDT$/, ''))
  return [
    ...PAPER_TESTING_SWITCHES.map((name) => (state.switches[name] ? t('{switch}: already on.', { switch: t(PAPER_TESTING_SWITCH_NAMES[name]) }) : t('{switch}: switched on.', { switch: t(PAPER_TESTING_SWITCH_NAMES[name]) }))),
    state.tagShort ? t("The Monitoring Tag's bracket short: on, and used in the news book.") : t("The Monitoring Tag's bracket short: off, and left off (Settings › Market switches it)."),
    t('Follows of the traders you follow on Copy Traders: {follows}; clones run: {clones}. They enter only positions opened from now.', { follows: num(state.follows), clones: num(state.clones) }),
    t("The baseline: Trend Regime Ensemble on {symbols}, long on Binance's spot, at its 4-hour closes from the next one, on signals of its own after Start.", { symbols: list(symbols) })
  ]
}

/** What Stop's confirmation lists: each switch Start turned on, put back as it was. */
export function stopItems(state: Pick<PaperTestingState, 'started'>, i18n: I18n): string[] {
  const { t } = i18n
  const switched = state.started?.switched ?? []
  if (switched.length === 0) return [t('No switch to put back: everything paper testing reads was already on at Start, and stays on.')]
  return switched.map((entry) => (entry.was ? t('{switch}: back on.', { switch: t(PAPER_TESTING_SWITCH_NAMES[entry.switch]) }) : t('{switch}: back off.', { switch: t(PAPER_TESTING_SWITCH_NAMES[entry.switch]) })))
}

function StandingsTable({ standings }: { standings: readonly BookStanding[] }): React.JSX.Element {
  const { t, num, money } = useI18n()
  const quote = (value: number | null): string => (value === null ? t('not priced') : money(value, 'USDT', 2))
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={headCellStyle}>{t('Book')}</th>
            <th style={headCellStyle}>{t('Equity')}</th>
            <th style={headCellStyle}>{t('Settled')}</th>
            <th style={headCellStyle}>{t('Open')}</th>
            <th style={headCellStyle}>{t('Closed')}</th>
            <th style={headCellStyle}>{t("Day's start")}</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((standing) => (
            <tr key={standing.id}>
              <td style={cellStyle}>{t(BOOK_NAMES[standing.id])}</td>
              <td style={cellStyle}>{quote(standing.equity)}</td>
              <td style={cellStyle}>{quote(standing.settledEquity)}</td>
              <td style={cellStyle}>{num(standing.open)}</td>
              <td style={cellStyle}>{num(standing.closed)}</td>
              <td style={cellStyle}>{quote(standing.dayStartEquity)}</td>
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

const itemStyle: React.CSSProperties = { fontSize: '0.74rem', lineHeight: 1.45, color: 'var(--text-secondary)' }

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
  const i18n = useI18n()
  const { t } = i18n
  const open = state.standings.reduce((sum, standing) => sum + standing.open, 0)
  const pendingStop = !state.running && state.started !== null
  return (
    <Card title={t('Paper testing')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <p style={noteStyle}>
          {t("Three paper books side by side, each on its own $10,000: the news book (the delisting rule's shorts on each coin's perpetual), the copy book (the traders you follow and the clones you run) and the baseline (Trend Regime Ensemble on its eight symbols). Nothing real is placed. A book is called profitable only after 30 closed trades from 10 separate events.")}
        </p>
        {state.running && state.startedAt !== null && (
          <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>{t('Running since {start} ({since}).', { start: utcWhen(i18n, state.startedAt * 1000), since: since(i18n, state.startedAt, nowSec) })}</p>
        )}
        {!state.running && (
          <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>{state.startedAt === null ? t('Not yet running.') : t('Stopped. The last run began {start}; its books as it ended:', { start: utcWhen(i18n, state.startedAt * 1000) })}</p>
        )}
        {(state.running || state.startedAt !== null) && <StandingsTable standings={state.standings} />}
        {state.running && <p style={noteStyle}>{readerLine(state, nowSec, i18n)}</p>}
        {state.running && state.started !== null && (
          <p style={noteStyle}>
            {state.started.switched.length === 0
              ? t('Start turned nothing on: everything it reads was already on.')
              : t('Start turned on: {switches}.', { switches: state.started.switched.map((entry) => t(PAPER_TESTING_SWITCH_NAMES[entry.switch])).join('; ') })}
          </p>
        )}
        {pendingStop && <p style={{ ...noteStyle, color: 'var(--down)' }}>{t('The last Stop could not put every switch back. Stop paper testing again.')}</p>}
        {confirming === null && (
          <div>
            {state.running || pendingStop ? (
              <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={() => onAsk('stop')}>
                {t('Stop paper testing')}
              </button>
            ) : (
              <button type="button" style={buttonStyle('primary', busy)} disabled={busy} onClick={() => onAsk('start')}>
                {t('Start paper testing')}
              </button>
            )}
          </div>
        )}
        {confirming === 'start' && (
          <div style={confirmStyle}>
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t('Start paper testing?')}</span>
            {startItems(state, i18n).map((item) => (
              <span key={item} style={itemStyle}>
                {item}
              </span>
            ))}
            <span style={itemStyle}>{t("Stop puts back each switch Start turned on, and closes the books' open trades at the price then.")}</span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={onCancel}>
                {t('Cancel')}
              </button>
              <button type="button" style={buttonStyle('primary', busy)} disabled={busy} onClick={onStart}>
                {t('Start paper testing')}
              </button>
            </div>
          </div>
        )}
        {confirming === 'stop' && (
          <div style={confirmStyle}>
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t('Stop paper testing?')}</span>
            <span style={itemStyle}>{open === 0 ? t('No trade of the books is open.') : t("The books' {count} open trades close at the price then.", { count: open })}</span>
            {stopItems(state, i18n).map((item) => (
              <span key={item} style={itemStyle}>
                {item}
              </span>
            ))}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={onCancel}>
                {t('Cancel')}
              </button>
              <button type="button" style={buttonStyle('primary', busy)} disabled={busy} onClick={onStop}>
                {t('Stop paper testing')}
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

export function PaperTestingCard({ askStart = false, onAskTaken }: { askStart?: boolean; onAskTaken?: () => void } = {}): React.JSX.Element | null {
  const { t } = useI18n()
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
  // Home's tile asked for Start: its confirmation opened once the books are read, where they do not run.
  useEffect(() => {
    if (!askStart || state === null) return
    onAskTaken?.()
    if (!state.running && state.started === null) setConfirming('start')
  }, [askStart, state, onAskTaken])

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

  if (state === null) {
    return problem === null ? null : (
      <Card title={t('Paper testing')}>
        <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>
      </Card>
    )
  }
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
          return t('Paper testing started.')
        })
      }
      onStop={() =>
        void press(async () => {
          const { closed } = await stopPaperTesting()
          return closed.length === 0 ? t('Paper testing stopped.') : t('Paper testing stopped: {count} trades closed.', { count: closed.length })
        })
      }
    />
  )
}
