import { useEffect, useState } from 'react'
import { AI_ADDITION_PROMPT_VERSIONS, newsReadingsOf, type NewsReading } from '../../shared/aiAdditions'
import type { NewsFeedState } from '../../shared/newsFeed'

/** How far back the analyst's readings are read: the week of stories the feed shows. */
const READINGS_SECONDS = 8 * 86_400
const ROWS_READ = 1000

/** The news analyst's readings of the stories on show, by story id (shared/aiAdditions.ts): read from
 * the ledger, where each call the analyst makes is written, again whenever the feed changes. Reading
 * them costs nothing; the analyst asks in the main process, by itself. */
export function useNewsReadings(feed: NewsFeedState | null): Record<string, NewsReading> {
  const [readings, setReadings] = useState<Record<string, NewsReading>>({})
  const updatedAt = feed?.updatedAt ?? null
  useEffect(() => {
    let cancelled = false
    const sinceSec = Math.floor(Date.now() / 1000) - READINGS_SECONDS
    window.api.ai.listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, sinceSec, limit: ROWS_READ }).then(
      (page) => {
        if (!cancelled) setReadings(newsReadingsOf(page.rows))
      },
      () => undefined
    )
    return (): void => {
      cancelled = true
    }
  }, [updatedAt])
  return readings
}
