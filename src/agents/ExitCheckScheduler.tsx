import { useEffect } from 'react'
import { EXIT_LOOK_MS, exitCheckBrowserDeps, lookAtOpenTrades } from './exitCheck'

/** The exit check, headless, on its own clock (src/agents/exitCheck.ts). It looks at the app's own
 * open paper trades every two minutes, does nothing while the watch is off, and asks only when
 * something about a trade has changed. One look at a time. */
export function ExitCheckScheduler(): null {
  useEffect(() => {
    let looking = false
    const look = (): void => {
      if (looking) return
      looking = true
      void lookAtOpenTrades(exitCheckBrowserDeps)
        .catch((failure: unknown) => console.error('The exit check could not look at the paper trades:', failure))
        .finally(() => {
          looking = false
        })
    }
    look()
    const timer = setInterval(look, EXIT_LOOK_MS)
    return (): void => clearInterval(timer)
  }, [])

  return null
}
