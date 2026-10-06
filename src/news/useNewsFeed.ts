import { useEffect, useState } from 'react'
import type { NewsFeedState } from '../../shared/newsFeed'

/** The news feed as the main process holds it (electron/services/newsFeedService.ts), kept current
 * as it reads. Null until first read. */
export function useNewsFeed(): NewsFeedState | null {
  const [state, setState] = useState<NewsFeedState | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.feed.getState().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      () => undefined
    )
    const stop = window.api.feed.onUpdate((next) => {
      if (!cancelled) setState(next)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])
  return state
}
