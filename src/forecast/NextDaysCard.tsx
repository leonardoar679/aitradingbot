import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import type { DailyForecastView } from '../../shared/forecast/daily/dailyRecord'
import { DAILY_HORIZONS, type DailyHorizon } from '../../shared/forecast/daily/dailySize'
import { pairWords } from '../calls/callText'
import { utcWhen } from '../traders/traderText'
import { msg, useI18n, type I18n } from '../i18n'

// THE NEXT DAYS (V10 Stage 4, 19 November 2026; V10-DAILY-SIZE held). The person asked about tomorrow, the day after and a
// few days later. Each coin's move expected either way over one, three and seven days from today's open, with its 80%
// range, by the daily rule (shared/forecast/daily/dailySize.ts), which held on January 2024 to October 2026: eight
// outcomes in ten inside the range, the real moves 1.00 to 1.06 times the size. The way is unknown: V10-TSMOM, the one
// test of a way over these days, failed. It reads; it places nothing.

const DAILY_NAME: Readonly<Record<DailyHorizon, string>> = { day1: msg('1 day'), days3: msg('3 days'), days7: msg('7 days') }

/** A coin's expected move at a daily horizon and its 80% range: "±3.10%" over "-5.20% to +5.48%". */
function cellOf(levels: { q: number[]; size: number } | undefined, { t, pct, pctPlain }: I18n): { size: string; range: string } | null {
  if (levels === undefined) return null
  return { size: t('±{size}', { size: pctPlain(levels.size, 2) }), range: t('{low} to {high}', { low: pct(levels.q[0], 2), high: pct(levels.q[4], 2) }) }
}

/** What the card shows: pure. */
export function NextDaysView({ view, onOpen }: { view: DailyForecastView | null; onOpen: (pair: string) => void }): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  const rows = [...(view?.rows ?? [])].sort((a, b) => (b.h.days7?.size ?? b.h.day1?.size ?? 0) - (a.h.days7?.size ?? a.h.day1?.size ?? 0))
  return (
    <Card title={t('The next days')}>
      <p style={noteStyle}>
        {t("Each coin's expected move either way over one, three and seven days from today's open, and its 80% range. The size held on January 2024 to October 2026: eight outcomes in ten inside the range, the real moves 1.00 to 1.06 times the size. Which way is unknown: the test of a way over these days failed.")}
      </p>
      {view === null ? (
        <p style={noteStyle}>{t('Reading the record…')}</p>
      ) : rows.length === 0 ? (
        <p style={noteStyle}>{t('No daily forecast yet: it is made a little after each day opens at 00:00 UTC.')}</p>
      ) : (
        <>
          {view.at !== null && <p style={{ ...noteStyle, marginTop: '0.3rem' }}>{t('Made {when}, from the day\'s open.', { when: utcWhen(i18n, view.at * 1000) })}</p>}
          <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>{t('Coin')}</th>
                  {DAILY_HORIZONS.map((horizon) => (
                    <th key={horizon} style={headCellStyle}>
                      {t(DAILY_NAME[horizon])}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.pair} onClick={() => onOpen(row.pair)} style={{ cursor: 'pointer' }}>
                    <td dir="ltr" style={{ ...cellStyle, fontWeight: 600 }}>
                      {pairWords(row.pair)}
                    </td>
                    {DAILY_HORIZONS.map((horizon) => {
                      const cell = cellOf(row.h[horizon], i18n)
                      return (
                        <td key={horizon} style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>
                          {cell === null ? (
                            '—'
                          ) : (
                            <>
                              <strong>{cell.size}</strong>
                              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{cell.range}</div>
                            </>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

/** The card, reading the day's forecasts as the forecast's passes go. */
export function NextDaysCard({ onOpen }: { onOpen: (pair: string) => void }): React.JSX.Element {
  const [view, setView] = useState<DailyForecastView | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.api.forecast.daily().then(
        (next) => {
          if (live) setView(next)
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
  return <NextDaysView view={view} onOpen={onOpen} />
}
