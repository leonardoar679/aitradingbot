import { useEffect } from 'react'
import { healPaperDigest, planPaperDigest } from '../../shared/paperDigest'
import { settingsWrites } from '../utils/settingsWrites'
import { noticeI18n } from '../i18n/current'

/** How often it looks whether a new UTC day has begun. */
const LOOK_MS = 5 * 60_000

/** The daily notice of what the app's own paper trades did the UTC day before
 * (shared/paperDigest.ts): headless, on its own clock, from settings.json and nothing else.
 *
 * The first look after midnight UTC tells the day before, and marks it told in settings.json in the
 * same turn of the one queue every settings write goes through, so that two looks, and a restart,
 * tell it once. It reads settings and raises a notice. It opens, closes and asks nothing. */
export function PaperDigestScheduler(): null {
  useEffect(() => {
    let cancelled = false
    const look = (): void => {
      settingsWrites(async () => {
        if (cancelled) return null
        const settings = await window.api.settings.get()
        const setting = healPaperDigest(settings.paperDigest)
        const plan = planPaperDigest({ setting, executors: settings.executors, nowSec: Math.floor(Date.now() / 1000) }, noticeI18n())
        if (plan === null) return null
        await window.api.settings.set({ paperDigest: { ...setting, lastDay: plan.day } })
        return plan.notice
      })
        .then((notice) => {
          if (notice !== null && !cancelled) void window.api.notify(notice.title, notice.body, 'watch', { kind: 'TRADE_EXECUTED', thread: 'paper-digest' }).catch(() => undefined)
        })
        .catch((failure: unknown) => console.error('The daily paper digest could not be read:', failure))
    }
    look()
    const timer = setInterval(look, LOOK_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return null
}
