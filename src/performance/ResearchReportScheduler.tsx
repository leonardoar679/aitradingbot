import { useEffect } from 'react'
import { RESEARCH_REPORT_LOOK_MS, lookAtResearchReports, researchReportBrowserDeps } from './researchReports'

/** How long after the app opens the first look is taken: after the scanner, the feed and the forecast have settled. */
const FIRST_LOOK_MS = 3 * 60_000

/** The research folder's reports, headless, on their own clock (./researchReports.ts): the last completed hour's
 * and the day before's, written into the folder where it does not hold them yet. One look at a time; it reads,
 * writes the reports and asks no model. */
export function ResearchReportScheduler(): null {
  useEffect(() => {
    let looking = false
    let timer: ReturnType<typeof setInterval> | null = null
    const look = (): void => {
      if (looking) return
      looking = true
      void lookAtResearchReports(researchReportBrowserDeps)
        .catch((failure: unknown) => console.error('The research folder report could not be written:', failure))
        .finally(() => {
          looking = false
        })
    }
    const first = setTimeout(() => {
      look()
      timer = setInterval(look, RESEARCH_REPORT_LOOK_MS)
    }, FIRST_LOOK_MS)
    return (): void => {
      clearTimeout(first)
      if (timer !== null) clearInterval(timer)
    }
  }, [])

  return null
}
