import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import type { AccuracyBoard } from '../../shared/evaluation/accuracyBoard'
import type { SourceFiguresRow } from '../../shared/evaluation/predictionRecord'
import { HORIZON_NAME } from '../../shared/forecast/words'
import type { BookId } from '../../shared/paperBooks'
import type { PaperTestingState } from '../../shared/paperTesting'
import { msg, useI18n } from '../i18n'

// HOME'S TILES (V8 Stage 10, 27 October 2026; the plan's Home): a news link and a trader pasted where the app opens --
// each handed to its own page, which reads it as a paste there would be read -- how the recorded calls came out, and
// the three paper books: their starting money and Start where paper testing has not run, each one's money where it
// does. A tile reads; what it starts, its page does.

const BOOK_NAMES: Record<BookId, string> = { news: msg('News book'), copy: msg('Copy book'), baseline: msg('Baseline') }

const SOURCE_NAMES: Record<string, string> = {
  'delisting-rule': msg('The delisting rule'),
  'direction-model': msg('A direction model'),
  article: msg("Articles' readings"),
  user: msg('Your own views'),
  'big-movers': msg('The big-mover list'),
  'top-traders': msg("The found traders' consensus"),
  'ai-daily': msg('The AI daily direction test')
}

const tileStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.5rem' }

/** A paste and its button: the text handed on as it is. */
function PasteTile({ title, note, placeholder, button, onPaste }: { title: string; note: string; placeholder: string; button: string; onPaste: (text: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const ready = text.trim() !== ''
  return (
    <Card title={title}>
      <div style={tileStyle}>
        <p style={noteStyle}>{note}</p>
        <input value={text} onChange={(change) => setText(change.target.value)} onKeyDown={(key) => key.key === 'Enter' && ready && onPaste(text.trim())} placeholder={placeholder} style={inputStyle()} dir="ltr" aria-label={title} />
        <div>
          <button type="button" style={buttonStyle('primary', !ready)} disabled={!ready} onClick={() => onPaste(text.trim())}>
            {button}
          </button>
        </div>
      </div>
    </Card>
  )
}

export function NewsPasteTile({ onPaste }: { onPaste: (text: string) => void }): React.JSX.Element {
  const { t } = useI18n()
  return <PasteTile title={t('Paste a news link')} note={t('Read on News URLs: its time, who says it, the coins it names and what their prices did.')} placeholder="https://…" button={t('Analyze')} onPaste={onPaste} />
}

export function TraderPasteTile({ onPaste }: { onPaste: (text: string) => void }): React.JSX.Element {
  const { t } = useI18n()
  return <PasteTile title={t('Paste a trader')} note={t('Read on Copy Traders: what the record made after fees and funding, and whether it looks like skill.')} placeholder={t('0x… or an OKX code')} button={t('Read and analyse')} onPaste={onPaste} />
}

/** How the forecast and the recorded calls came out (since V10 Stage 2): the forecast's size against the real moves at
 * four hours and a day, and each source with a side, right on the rises and on the falls apart -- a source always on
 * one side is right on every move one way and on none the other. */
export function PerformanceTileView({ rows, board, onOpen }: { rows: readonly SourceFiguresRow[] | null; board?: AccuracyBoard | null; onOpen: () => void }): React.JSX.Element {
  const { t, num, pctPlain } = useI18n()
  const scored = (rows ?? []).filter((row) => row.kind === 'direction' && row.figures.n > 0)
  const share = (value: number | undefined): string => (value === undefined ? '—' : pctPlain(value * 100, 0))
  const forecast = (board?.horizons ?? []).filter((row) => (row.h === 'hours4' || row.h === 'hours24') && row.sizeRatio !== null && row.in80 !== null)
  return (
    <Card title={t('Did it come true?')}>
      <div style={tileStyle}>
        {forecast.map((row) => (
          <p key={row.h} style={{ ...noteStyle, color: 'var(--text-primary)' }}>
            {t('The forecast at {horizon}: real moves {ratio} the size it expected, {in80} inside its 80% range', { horizon: t(HORIZON_NAME[row.h]), ratio: t('{value}×', { value: num(row.sizeRatio!.value, 2, 2) }), in80: share(row.in80!.value) })}
          </p>
        ))}
        {rows === null ? (
          <p style={noteStyle}>{t('Reading the record…')}</p>
        ) : scored.length === 0 ? (
          <p style={noteStyle}>{t('No call has been scored yet: a call is scored once its time has passed.')}</p>
        ) : (
          scored.map((row) => (
            <p key={row.source} style={{ ...noteStyle, color: 'var(--text-primary)' }}>
              {t('{source}: right on {rising} of the rises and {falling} of the falls, {scored} scored', {
                source: SOURCE_NAMES[row.source] === undefined ? row.source : t(SOURCE_NAMES[row.source]),
                rising: share(row.figures.rightOnRising?.value),
                falling: share(row.figures.rightOnFalling?.value),
                scored: num(row.figures.n)
              })}
            </p>
          ))
        )}
        <div>
          <button type="button" style={buttonStyle('secondary')} onClick={onOpen}>
            {t('Open Performance')}
          </button>
        </div>
      </div>
    </Card>
  )
}

export function PerformanceTile({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const [rows, setRows] = useState<SourceFiguresRow[] | null>(null)
  const [board, setBoard] = useState<AccuracyBoard | null>(null)
  useEffect(() => {
    let live = true
    void window.api.predictions
      .figures()
      .then((read) => {
        if (live) setRows(read)
      })
      .catch(() => {
        if (live) setRows([])
      })
    void window.api.forecast.board().then(
      (read) => {
        if (live) setBoard(read)
      },
      () => undefined
    )
    return (): void => {
      live = false
    }
  }, [])
  return <PerformanceTileView rows={rows} board={board} onOpen={onOpen} />
}

/** The three books: their starting money and Start before paper testing runs, each one's money while it does. */
export function PortfolioTileView({ state, onStart, onOpen }: { state: PaperTestingState | null; onStart: () => void; onOpen: () => void }): React.JSX.Element {
  const { t, money } = useI18n()
  return (
    <Card title={t('Paper testing')}>
      <div style={tileStyle}>
        {state === null ? (
          <p style={noteStyle}>{t('Reading the books…')}</p>
        ) : !state.running ? (
          <>
            <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>{t('Starting balance {money} a book · Not yet running', { money: money(10_000, 'USDT', 0) })}</p>
            <div>
              <button type="button" style={buttonStyle('primary')} onClick={onStart}>
                {t('Start paper testing')}
              </button>
            </div>
          </>
        ) : (
          <>
            {state.standings.map((standing) => (
              <p key={standing.id} style={{ ...noteStyle, color: 'var(--text-primary)', display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                <span>{t(BOOK_NAMES[standing.id])}</span>
                <span>{standing.equity === null ? money(standing.settledEquity, 'USDT', 2) : money(standing.equity, 'USDT', 2)}</span>
              </p>
            ))}
            <div>
              <button type="button" style={buttonStyle('secondary')} onClick={onOpen}>
                {t('Open Paper Trading')}
              </button>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

export function PortfolioTile({ onStart, onOpen }: { onStart: () => void; onOpen: () => void }): React.JSX.Element {
  const [state, setState] = useState<PaperTestingState | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.api.books
        .testing()
        .then((next) => {
          if (live) setState(next)
        })
        .catch(() => undefined)
    }
    read()
    const timer = setInterval(read, 30_000)
    return (): void => {
      live = false
      clearInterval(timer)
    }
  }, [])
  return <PortfolioTileView state={state} onStart={onStart} onOpen={onOpen} />
}
