import { useEffect, useState } from 'react'
import type { ResearchState } from '../../shared/marketResearch'

/** The market research the main process does at launch and every ten minutes
 * (electron/services/marketResearchService.ts), kept current as it reports. Null until first read.
 * `refresh` asks it to read the market again now. */
export function useMarketResearch(): { state: ResearchState | null; refresh: () => void } {
  const [state, setState] = useState<ResearchState | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.research.getState().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      () => undefined
    )
    const stop = window.api.research.onUpdate((next) => {
      if (!cancelled) setState(next)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  return { state, refresh: () => void window.api.research.refresh().catch(() => undefined) }
}
