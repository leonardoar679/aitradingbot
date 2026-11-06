import { useEffect } from 'react'
import { healAlerts } from '../../shared/alerts'
import { healSoundSettings } from '../../shared/sounds'
import { hearNotice, setSoundPrefs, soundOfRecord, topPredictionChime } from './hearing'
import { showToast } from './NoticeToasts'
import { noticeI18n } from '../i18n/current'

/** How often the controls are read again, so a change on Settings is heard within it. */
const PREFS_MS = 30_000

/** Headless -- mounted once in App.tsx. Each notice told is shown as a toast and, under the controls,
 * heard (./hearing.ts); CRITICAL is the banner's to show, and is heard here when it is told. The top
 * prediction changing pair chimes, at most once in half an hour, with a toast. It plays and shows;
 * it acts on nothing. */
export function NoticeSounds(): null {
  useEffect(() => {
    let cancelled = false
    const readPrefs = (): void => {
      void window.api.settings.get().then(
        (settings) => {
          if (!cancelled) setSoundPrefs({ alerts: healAlerts(settings.alerts), sounds: healSoundSettings(settings.sounds) })
        },
        () => undefined
      )
    }
    readPrefs()
    const timer = setInterval(readPrefs, PREFS_MS)
    const stopTold = window.api.records.onTold((record) => {
      if (cancelled) return
      hearNotice(record)
      if (record.severity !== 'critical') showToast({ id: record.id, title: record.title, body: record.body, sound: soundOfRecord(record) })
    })
    const stopForecast = window.api.forecast.onUpdate(() => {
      void window.api.forecast.ranking().then(
        (ranking) => {
          const top = ranking.ranked[0]?.pair ?? null
          if (cancelled || !topPredictionChime(top, Math.floor(Date.now() / 1000)) || top === null) return
          // Not a desktop notice: a chime and a toast, as the document has it (§72), in the person's language.
          const { t } = noticeI18n()
          hearNotice({ sound: 'information', kind: null, severity: 'watch' } as never)
          showToast({ id: `top:${top}:${Date.now()}`, title: t('Top prediction: {pair}', { pair: top.replace(/USDT$/, '/USDT') }), body: t('The best-ranked forecast is now on another pair. Predictions shows it.'), sound: 'information' })
        },
        () => undefined
      )
    })
    return (): void => {
      cancelled = true
      clearInterval(timer)
      stopTold()
      stopForecast()
    }
  }, [])
  return null
}
