import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import type { SourceFiguresRow } from '../../shared/evaluation/predictionRecord'
import type { Figure } from '../../shared/forecast/uncertainty'
import { msg, useI18n, type I18n } from '../i18n'

// DID IT COME TRUE? (V8 Stage 10, 27 October 2026). Every prediction the app recorded that is not the price forecast's
// own -- a card from a measured source, an article's reading, a person's own view -- scored once its time had passed
// (shared/evaluation/predictionRecord.ts): whether its side was right, what it would have made after the route's costs,
// how far its size was off, whether it touched its target. A line a source and kind, each figure with its 95% interval
// resampled by the source's unit of evidence. It reads the record; it records and places nothing.

const SOURCE_NAMES: Record<string, string> = {
  'delisting-rule': msg('The delisting rule'),
  'direction-model': msg('A direction model'),
  article: msg("Articles' readings"),
  user: msg('Your own views'),
  'big-movers': msg('The big-mover list')
}

const KIND_NAMES = { direction: msg('side and size'), size: msg('size alone') } as const

/** A share with its interval, in percent: "62% (48–75%)"; the point alone where no interval could be read. */
export function shareText(figure: Figure | null, { t, pctPlain }: I18n): string {
  if (figure === null) return '—'
  if (!Number.isFinite(figure.low) || !Number.isFinite(figure.high)) return pctPlain(figure.value * 100, 0)
  return t('{value} ({low} to {high})', { value: pctPlain(figure.value * 100, 0), low: pctPlain(figure.low * 100, 0), high: pctPlain(figure.high * 100, 0) })
}

/** A move with its interval, signed, in percent. */
export function moveText(figure: Figure | null, { t, pct }: I18n): string {
  if (figure === null) return '—'
  if (!Number.isFinite(figure.low) || !Number.isFinite(figure.high)) return pct(figure.value, 2)
  return t('{value} ({low} to {high})', { value: pct(figure.value, 2), low: pct(figure.low, 2), high: pct(figure.high, 2) })
}

export function CameTrueView({ rows }: { rows: readonly SourceFiguresRow[] | null }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num } = i18n
  return (
    <Card title={t('Did it come true?')}>
      <p style={noteStyle}>
        {t("Each prediction recorded that is not the price forecast's own -- a card from a measured source, an article's reading, your own view -- scored once its time had passed: whether its side was right, what it would have made after the route's costs, how far its size was off, and whether it reached its target. Intervals are 95%, resampled by each source's unit of evidence.")}
      </p>
      {rows === null ? (
        <p style={noteStyle}>{t('Reading the record…')}</p>
      ) : rows.length === 0 ? (
        <p style={noteStyle}>{t('Nothing recorded yet: a prediction is recorded when a card is shown, an article is read, or you paper trade your own view.')}</p>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: '0.6rem' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>{t('Source')}</th>
                <th style={headCellStyle}>{t('Scored')}</th>
                <th style={headCellStyle}>{t('Side right')}</th>
                <th style={headCellStyle}>{t('Net after costs')}</th>
                <th style={headCellStyle}>{t('Size off by')}</th>
                <th style={headCellStyle}>{t('Reached its target')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.source}|${row.kind}`}>
                  <td style={cellStyle}>
                    {SOURCE_NAMES[row.source] === undefined ? <bdi lang="en">{row.source}</bdi> : t(SOURCE_NAMES[row.source])} · {t(KIND_NAMES[row.kind])}
                  </td>
                  <td style={cellStyle}>{t('{scored} of {made}', { scored: num(row.figures.n), made: num(row.total) })}</td>
                  <td style={cellStyle}>{row.kind === 'size' ? '—' : shareText(row.figures.right, i18n)}</td>
                  <td style={cellStyle}>{moveText(row.figures.net, i18n)}</td>
                  <td style={cellStyle}>{moveText(row.figures.sizeError, i18n)}</td>
                  <td style={cellStyle}>{shareText(row.figures.touched, i18n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export function CameTrueCard(): React.JSX.Element {
  const [rows, setRows] = useState<SourceFiguresRow[] | null>(null)
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
    return (): void => {
      live = false
    }
  }, [])
  return <CameTrueView rows={rows} />
}
