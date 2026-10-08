import { useEffect } from 'react'
import { healPaperPause, planPaperPause } from '../../shared/paperPause'
import { settingsWrites } from '../utils/settingsWrites'

/** How often it reads the record: the watch and the news rules settle a closed trade once a
 * minute. */
const LOOK_MS = 60_000

/** The pause after a losing run of the app's own paper trades (shared/paperPause.ts): headless, on
 * its own clock, from settings.json and nothing else.
 *
 * A look that finds the watch's run, or the news rules', at the loss that pauses it writes the
 * pause down -- in one turn of the queue every settings write goes through, so two looks, and a
 * restart, pause and tell it once -- and raises one desktop notice. What it writes is the pause and
 * nothing else: never the executors, and it closes nothing. The two that open trades read the pause
 * and refuse; it is lifted only by Resume, on Risk & Safety. */
export function PaperPauseScheduler(): null {
  useEffect(() => {
    let cancelled = false
    const look = (): void => {
      settingsWrites(async () => {
        if (cancelled) return []
        const settings = await window.api.settings.get()
        const plan = planPaperPause({ setting: healPaperPause(settings.paperPause), executors: settings.executors, nowSec: Math.floor(Date.now() / 1000) })
        if (plan === null) return []
        await window.api.settings.set({ paperPause: plan.setting })
        return plan.notices
      })
        .then((notices) => {
          if (cancelled) return
          for (const notice of notices) void window.api.notify(notice.title, notice.body, undefined, { kind: 'CIRCUIT_BREAKER', thread: 'paper-pause' }).catch(() => undefined)
        })
        .catch((failure: unknown) => console.error('The losing-run pause could not read the paper trades:', failure))
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
