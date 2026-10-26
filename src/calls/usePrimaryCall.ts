import { useEffect, useState } from 'react'
import type { PrimaryCallState } from '../../shared/forecast/primaryCall'

/** The primary call as last weighed (V8 Stage 3; electron/services/primaryCallService.ts), kept current by its
 * pushes; null before the first answer. Reading it records, opens and places nothing. */
export function usePrimaryCall(): PrimaryCallState | null {
  const [state, setState] = useState<PrimaryCallState | null>(null)
  useEffect(() => {
    let live = true
    void window.api.calls
      .state()
      .then((read) => {
        if (live) setState(read)
      })
      .catch(() => undefined)
    const stop = window.api.calls.onUpdate((read) => setState(read))
    return (): void => {
      live = false
      stop()
    }
  }, [])
  return state
}
