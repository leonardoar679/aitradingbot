import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import type { AccuracyBoard, BoardEntry, BoardFigure, BoardHorizon } from '../../shared/evaluation/accuracyBoard'
import { HORIZON_NAME } from '../../shared/forecast/words'
import type { Horizon } from '../../shared/forecast/features'
import { useI18n, type I18n } from '../i18n'
import { utcWhen } from '../traders/traderText'

// HOW THE FORECAST DID (V10 Stage 2, 19 November 2026; shared/evaluation/accuracyBoard.ts). The price forecast checked
// the way the person asked: when each forecast's time was up, whether the way it pointed was right -- on the moves that
// rose and on those that fell apart, so a market going one way cannot make a lean look like skill -- how big the real
// move was against the move it expected, and whether the close fell inside its 80% range. Over the last 30 days and
// over the last day, with the latest forecasts checked one by one. It reads the record; it records and places nothing.

/** The forecasts listed one by one: the ones whose sizes matter most to a person. */
const LISTED: readonly Horizon[] = ['hours4', 'hours24']
const LISTED_COUNT = 12

/** A share with its interval, in percent: "62% (48% to 75%)"; the point alone where no interval could be read. */
function shareOf(figure: BoardFigure | null, { t, pctPlain }: I18n): string {
  if (figure === null) return '—'
  if (figure.low === null || figure.high === null) return pctPlain(figure.value * 100, 0)
  return t('{value} ({low} to {high})', { value: pctPlain(figure.value * 100, 0), low: pctPlain(figure.low * 100, 0), high: pctPlain(figure.high * 100, 0) })
}

/** A ratio with its interval: "0.97× (0.88× to 1.05×)". */
function ratioOf(figure: BoardFigure | null, { t, num }: I18n): string {
  if (figure === null) return '—'
  const times = (value: number): string => t('{value}×', { value: num(value, 2, 2) })
  if (figure.low === null || figure.high === null) return times(figure.value)
  return t('{value} ({low} to {high})', { value: times(figure.value), low: times(figure.low), high: times(figure.high) })
}

function entryText(entry: BoardEntry, i18n: I18n): string {
  const { t, pct } = i18n
  const expected = entry.size === null ? t('size not recorded') : t('expected ±{size}', { size: i18n.pctPlain(entry.size, 2) })
  const way = entry.called === null ? t('way not called') : entry.called === 'up' ? t('called UP') : t('called DOWN')
  return t('{expected}, moved {move}, {inside}, {way}', { expected, move: pct(entry.move, 2), inside: entry.in80 ? t('inside the 80% range') : t('outside the 80% range'), way })
}

function HorizonTable({ rows, i18n }: { rows: readonly BoardHorizon[]; i18n: I18n }): React.JSX.Element {
  const { t, num, pctPlain } = i18n
  return (
    <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            {[t('Horizon'), t('Checked'), t('Points a way'), t('Right when it rose'), t('Right when it fell'), t('Real move against expected'), t('Inside the 80% range')].map((name) => (
              <th key={name} style={headCellStyle}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.h}>
              <td style={{ ...cellStyle, fontWeight: 600 }}>{t(HORIZON_NAME[row.h])}</td>
              <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{num(row.n, 0, 0)}</td>
              <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{row.pointedShare === null ? '—' : pctPlain(row.pointedShare * 100, 0)}</td>
              <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{shareOf(row.pointed.rightOnRising, i18n)}</td>
              <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{shareOf(row.pointed.rightOnFalling, i18n)}</td>
              <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{ratioOf(row.sizeRatio, i18n)}</td>
              <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{shareOf(row.in80, i18n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** What the card shows: pure. */
export function AccuracyBoardView({ board, span, onSpan }: { board: AccuracyBoard | null; span: 'month' | 'day'; onSpan: (span: 'month' | 'day') => void }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num } = i18n
  const rows = board === null ? [] : span === 'month' ? board.horizons : board.lastDay
  const called = rows.reduce((sum, row) => sum + row.called.n, 0)
  const listed = (board?.recent ?? []).filter((entry) => LISTED.includes(entry.h)).slice(0, LISTED_COUNT)
  return (
    <Card title={t('How the forecast did')}>
      <p style={noteStyle}>
        {t("Each forecast is checked when its time is up: whether the way its middle pointed was right, on the moves that rose and on those that fell apart -- a forecast that always points one way is right on every move one way and on none the other, so a falling week cannot make a lean look like skill -- how big the real move was against the move it expected either way, and whether the close fell inside its 80% range. Ranges are 95%, resampled by whole days, since coins move together.")}
      </p>
      {board === null ? (
        <p style={noteStyle}>{t('Reading the record…')}</p>
      ) : board.horizons.every((row) => row.n === 0) ? (
        <p style={noteStyle}>{board.filling ? t('Reading the days before from the record…') : t('Nothing checked yet: a forecast is checked once its time is up.')}</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem', alignItems: 'center' }}>
            <button type="button" style={buttonStyle(span === 'month' ? 'primary' : 'secondary', false)} onClick={() => onSpan('month')}>
              {t('Last 30 days')}
            </button>
            <button type="button" style={buttonStyle(span === 'day' ? 'primary' : 'secondary', false)} onClick={() => onSpan('day')}>
              {t('Last day')}
            </button>
            {board.from !== null && board.to !== null && (
              <span style={{ ...noteStyle, margin: 0 }}>{t('Days counted: {from} to {to}.', { from: utcWhen(i18n, board.from * 1000), to: utcWhen(i18n, (board.to + 86_399) * 1000) })}</span>
            )}
          </div>
          <HorizonTable rows={rows} i18n={i18n} />
          <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
            {called === 0
              ? t('The app called no way, UP or DOWN, in these days: no source has passed a test of its way at these horizons, so each forecast says the size and leaves the way unknown.')
              : t('The app called a way, UP or DOWN, on {calls} of them.', { calls: num(called, 0, 0) })}
            {board.filling && <> {t('Reading the days before from the record…')}</>}
          </p>
          {listed.length > 0 && (
            <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.84rem' }}>
              <span style={{ fontWeight: 600 }}>{t('The latest forecasts checked:')}</span>
              {listed.map((entry) => (
                <span key={`${entry.pair}:${entry.h}:${entry.t}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <bdi dir="ltr">{entry.pair}</bdi> · {t(HORIZON_NAME[entry.h])} · {entryText(entry, i18n)}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  )
}

/** The card, reading the board as the forecast's passes settle outcomes. */
export function AccuracyBoardCard(): React.JSX.Element {
  const [board, setBoard] = useState<AccuracyBoard | null>(null)
  const [span, setSpan] = useState<'month' | 'day'>('month')
  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.api.forecast.board().then(
        (next) => {
          if (live) setBoard(next)
        },
        () => undefined
      )
    }
    read()
    const stop = window.api.forecast.onUpdate(read)
    return (): void => {
      live = false
      stop()
    }
  }, [])
  return <AccuracyBoardView board={board} span={span} onSpan={setSpan} />
}
