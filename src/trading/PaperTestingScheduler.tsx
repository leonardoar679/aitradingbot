import { useEffect } from 'react'
import { closeLeftoverBookTrades } from './paperTesting'

// A STOP CUT SHORT, FINISHED (V8 Stage 9, 27 October 2026). At mount and every ten minutes: where the paper books are
// stopped and a trade of theirs is still open -- the app closed between a Stop and its closes -- it is closed at the
// price then (src/trading/paperTesting.ts). While the books run it does nothing.

const CHECK_MS = 10 * 60_000

export function PaperTestingScheduler(): null {
  useEffect(() => {
    const check = (): void => {
      void closeLeftoverBookTrades()
        .then((closed) => {
          if (closed.length > 0) console.info(`Paper testing was stopped with trades open: closed ${closed.join(', ')}`)
        })
        .catch((error) => console.error("The stopped books' open trades could not be closed:", error))
    }
    check()
    const timer = setInterval(check, CHECK_MS)
    return (): void => clearInterval(timer)
  }, [])
  return null
}
