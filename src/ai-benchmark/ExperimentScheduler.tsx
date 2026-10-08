import { useEffect } from 'react'
import { experimentStatusAt, type ExperimentRun } from '../../shared/experimentRun'
import { buildExperimentReport, experimentReportBrowserDeps } from './experimentReport'

/** How often the runs are looked at for one that has ended without its report. */
const LOOK_MS = 60_000

/** Headless -- mounted once in App.tsx (V5 Stage 9, 8 October 2026). The main process keeps each
 * run's record and clock; this builds the report for a run that has ended and has none yet, from
 * what is on file, and hands it back to be filed. A run that ended while the app was closed is
 * reported at the next launch: the records it needs are on file. It reads; it asks no model and
 * opens nothing. One report at a time, so a slow read never builds the same report twice. */
export function ExperimentScheduler(): null {
  useEffect(() => {
    let cancelled = false
    let busy = false
    const look = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const { rows } = await window.api.experiments.list()
        const nowSec = Math.floor(Date.now() / 1000)
        const due = rows.filter((run) => run.report === undefined && experimentStatusAt(run, nowSec) !== 'running')
        for (const run of due) {
          if (cancelled) return
          const report = await buildExperimentReport(run, experimentReportBrowserDeps)
          if (cancelled) return
          await window.api.experiments.report(run.id, report)
        }
      } catch (failure) {
        console.error("An experiment's report could not be built:", failure)
      } finally {
        busy = false
      }
    }
    const timer = window.setInterval(() => void look(), LOOK_MS)
    const first = window.setTimeout(() => void look(), 15_000)
    // The main process says when a run ends: the report follows at once.
    const unsubscribe = window.api.experiments.onUpdate((run: ExperimentRun) => {
      if (run.status === 'ended' || run.status === 'stopped') void look()
    })
    return (): void => {
      cancelled = true
      window.clearInterval(timer)
      window.clearTimeout(first)
      unsubscribe()
    }
  }, [])
  return null
}
