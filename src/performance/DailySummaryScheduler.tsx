import { useEffect } from 'react'
import { DAILY_SUMMARY_LOOK_MS, dailySummaryBrowserDeps, lookAtDailySummary } from './dailySummary'

/** How long after the app opens the first look is taken: after the scanner and the feed have
 * settled, so that the day before's report reads a settled app. */
const FIRST_LOOK_MS = 2 * 60_000

/** The daily summary, headless, on its own clock (./dailySummary.ts): once a day after 00:05 UTC,
 * while the watch is on, the day before's report is built and put to the model for one paragraph.
 * One look at a time; it asks nothing else and writes nothing. */
export function DailySummaryScheduler(): null {
  useEffect(() => {
    let looking = false
    let timer: ReturnType<typeof setInterval> | null = null
    const look = (): void => {
      if (looking) return
      looking = true
      void lookAtDailySummary(dailySummaryBrowserDeps)
        .catch((failure: unknown) => console.error('The daily summary could not be asked for:', failure))
        .finally(() => {
          looking = false
        })
    }
    const first = setTimeout(() => {
      look()
      timer = setInterval(look, DAILY_SUMMARY_LOOK_MS)
    }, FIRST_LOOK_MS)
    return (): void => {
      clearTimeout(first)
      if (timer !== null) clearInterval(timer)
    }
  }, [])

  return null
}
