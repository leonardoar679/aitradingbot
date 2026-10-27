import { useEffect } from 'react'
import { BASELINE_BAR_SEC } from '../../shared/baseline'
import { BASELINE_ENTRY_WINDOW_SEC, baselineBrowserDeps, baselineDueBarOf, readBaseline } from './baselineTrade'

// THE BASELINE, RUNNING (V8 Stage 9, 27 October 2026). Mounted with the app's other schedulers: every half minute it
// looks whether a 4-hour close has passed by the thirty seconds the baseline reads it at, and reads it once
// (src/baseline/baselineTrade.ts) -- at mount too, so that a close passed while the app was shut is read, its exits
// settled and its entries missed as late, and again once paper testing starts. A read that could not read a symbol is
// made again until the entry window has passed. Nothing runs unless paper testing was started, and nothing it writes
// is anything but paper.

const CHECK_MS = 30_000

export function BaselineScheduler(): null {
  useEffect(() => {
    let readFor: number | null = null
    let busy = false
    const check = (): void => {
      if (busy) return
      const nowSec = Math.floor(Date.now() / 1000)
      const due = baselineDueBarOf(nowSec)
      if (due === readFor) return
      busy = true
      void readBaseline(baselineBrowserDeps)
        .then(({ running, lines, complete }) => {
          // Not running, nothing was read: the close is read once paper testing starts.
          if (running && (complete || Math.floor(Date.now() / 1000) - (due + BASELINE_BAR_SEC) > BASELINE_ENTRY_WINDOW_SEC)) readFor = due
          if (lines.length > 0) console.info(`The baseline read its close (${complete ? 'whole' : 'in part'}): ${lines.join('; ')}`)
        })
        .catch((error) => console.error('The baseline could not read its close:', error))
        .finally(() => {
          busy = false
        })
    }
    check()
    const timer = setInterval(check, CHECK_MS)
    return (): void => clearInterval(timer)
  }, [])
  return null
}
