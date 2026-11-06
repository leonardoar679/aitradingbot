import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { noteStyle } from '../agents/agentStyles'
import type { BtcTodayView } from '../../shared/forecast/btcDay'
import { nextReleases, type MacroKind } from '../../shared/calendar/macro'
import type { MarketShockState } from '../../shared/forecast/marketShock'
import { marketStateWord, signedPct } from '../forecast/forecastWords'
import { utcWhen } from '../traders/traderText'
import { msg, useI18n } from '../i18n'

// BITCOIN TODAY, ON HOME (V9 Stage 1, 6 November 2026). Bitcoin's UTC day so far, from the forecast's own bars; how
// often its days were big over the last 90 (a close 2% or 4% from the open, a fall to 4% below it) -- a frequency of
// the past, said as one: V9-BTC-DAY found the chances read from volatility ran too high from 2024 on; the next U.S.
// release the market waits on; the market's state now; and its way, which no measured source calls today.

const READ_MS = 60_000

const KIND_NAMES: Record<MacroKind, string> = {
  CPI: msg('U.S. consumer prices (CPI)'),
  PPI: msg('U.S. producer prices (PPI)'),
  JOBS: msg('U.S. jobs report'),
  FOMC: msg('U.S. Fed rate decision (FOMC)')
}

/** The tile, reading Bitcoin's day every minute. */
export function BitcoinTodayTile({ marketState }: { marketState: string | null }): React.JSX.Element {
  const [view, setView] = useState<BtcTodayView | null>(null)
  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      void window.api.forecast.btcToday().then(
        (next) => {
          if (!cancelled) setView(next)
        },
        () => undefined
      )
    }
    read()
    const timer = setInterval(read, READ_MS)
    // And after each of the forecast's passes, whose bars it reads: the first one after a start comes between the minutes.
    const stop = window.api.forecast.onUpdate(() => read())
    return (): void => {
      cancelled = true
      clearInterval(timer)
      stop()
    }
  }, [])
  return <BitcoinTodayCard view={view} marketState={marketState} />
}

/** What the tile shows of a reading: the day so far, the big days of the last 90, the next release, the market's
 * state and the way, which no measured source calls. */
export function BitcoinTodayCard({ view, marketState }: { view: BtcTodayView | null; marketState: string | null }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num } = i18n
  const nowSec = view?.at ?? Math.floor(Date.now() / 1000)
  const next = nextReleases(nowSec, 1)[0] ?? null
  const today = view?.today ?? null
  const days = view?.bigDays ?? null
  return (
    <Card title={t('Bitcoin today')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', fontSize: '0.84rem' }}>
        {today !== null && (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            <strong>{t('{move} since the 00:00 UTC open', { move: signedPct(today.movePct, 2, i18n) })}</strong>
          </span>
        )}
        {days !== null && (
          <span>
            {t('In the last {days} days, Bitcoin closed 2% or more from its open on {close2} days and 4% or more on {close4}, and fell 4% below its open at some point on {fall4}.', {
              days: num(days.days, 0, 0),
              close2: num(days.close2, 0, 0),
              close4: num(days.close4, 0, 0),
              fall4: num(days.fall4, 0, 0)
            })}
          </span>
        )}
        {next !== null && <span>{t('Next release: {kind}, {when}', { kind: t(KIND_NAMES[next.kind]), when: utcWhen(i18n, next.at * 1000) })}</span>}
        {marketState !== null && <span>{t('Market now: {state}', { state: marketStateWord(marketState as MarketShockState, i18n) })}</span>}
        <span>{t("Which way: unknown. No measured source calls Bitcoin's way now.")}</span>
        <p style={noteStyle}>{t("A frequency of the past, not a chance for today: chances read from Bitcoin's volatility ran too high from 2024 on.")}</p>
      </div>
    </Card>
  )
}
