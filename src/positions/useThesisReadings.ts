import { useEffect, useRef, useState } from 'react'
import { AI_ADDITION_PROMPT_VERSIONS, newsReadingsOf } from '../../shared/aiAdditions'
import { measureTheses, type ThesisDeps, type ThesisReading, type ThesisSubject } from './thesisMeasure'

/** How often the theses are measured while Positions is open. */
export const THESIS_LOOK_MS = 60_000
/** Rows of the analyst's readings read back at most. */
const READINGS_ROWS = 1000

/** The measuring, against the running app: it reads candles, the feed, and the ledger's news
 * readings. Reading them costs nothing; the analyst asks in the main process, by itself. */
export const thesisBrowserDeps: ThesisDeps = {
  fetchCandles: async (exchange, symbol, interval, startSec, endSec) => (await window.api.market.fetchHistoricalRange(exchange, symbol, interval, startSec, endSec)).candles,
  stories: async () => (await window.api.feed.getState()).stories,
  readings: async (sinceSec) =>
    newsReadingsOf((await window.api.ai.listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, sinceSec, limit: READINGS_ROWS })).rows),
  nowSec: () => Math.floor(Date.now() / 1000)
}

export interface ThesisReadings {
  readings: Record<string, ThesisReading>
  /** When they were last measured; null before the first measurement. */
  measuredAt: number | null
}

/** The theses of the subjects, measured now and once a minute, and again when the set of subjects
 * changes. The subjects' details are read as they stand at each look. */
export function useThesisReadings(subjects: ThesisSubject[], deps: ThesisDeps = thesisBrowserDeps): ThesisReadings {
  const [state, setState] = useState<ThesisReadings>({ readings: {}, measuredAt: null })
  const latest = useRef(subjects)
  latest.current = subjects
  const key = subjects
    .map((subject) => subject.id)
    .sort()
    .join(',')
  useEffect(() => {
    if (key === '') {
      setState({ readings: {}, measuredAt: null })
      return
    }
    let cancelled = false
    const look = async (): Promise<void> => {
      try {
        const readings = await measureTheses(latest.current, deps)
        if (!cancelled) setState({ readings, measuredAt: deps.nowSec() })
      } catch (failure) {
        console.error('The theses could not be measured:', failure)
      }
    }
    void look()
    const timer = setInterval(() => void look(), THESIS_LOOK_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [key, deps])
  return state
}
