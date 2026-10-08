import { useEffect, useState } from 'react'
import type { ScannerState } from '../../shared/marketScanner'

/** The scanner's state (electron/services/marketScannerService.ts), kept current as it reports:
 * its switch, its pairs as last read, its events. Null until first read. Public data; it asks,
 * places and writes nothing. */
export function useScanner(): ScannerState | null {
  const [state, setState] = useState<ScannerState | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.scanner.getState().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      () => undefined
    )
    const stop = window.api.scanner.onUpdate((next) => {
      if (!cancelled) setState(next)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  return state
}
