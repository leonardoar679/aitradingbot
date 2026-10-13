import { useEffect, useState } from 'react'
import type { PricePrediction } from '../../shared/forecast/prediction'
import type { ForecastRanking } from '../../shared/forecast/ranking'
import type { ForecastState } from '../../shared/ipc'

/** How often what the forecast stands at is read again besides each pass, for its status line. */
const STATE_MS = 30_000

/** The forecast as the main process holds it (electron/services/forecastService.ts): its state, every
 * pair's latest forecast and the ranking, read when a page opens and again after each pass. Reading
 * it costs nothing and asks nothing. */
export function useForecast(): { state: ForecastState | null; predictions: ReadonlyMap<string, PricePrediction>; ranking: ForecastRanking | null } {
  const [state, setState] = useState<ForecastState | null>(null)
  const [predictions, setPredictions] = useState<ReadonlyMap<string, PricePrediction>>(new Map())
  const [ranking, setRanking] = useState<ForecastRanking | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void Promise.all([window.api.forecast.getState(), window.api.forecast.list(), window.api.forecast.ranking()]).then(
        ([nextState, list, nextRanking]) => {
          if (cancelled) return
          setState(nextState)
          setPredictions(new Map(list.map((prediction) => [prediction.pair, prediction])))
          setRanking(nextRanking)
        },
        () => undefined
      )
    }
    load()
    const stop = window.api.forecast.onUpdate(() => load())
    const timer = setInterval(() => {
      void window.api.forecast.getState().then(
        (next) => {
          if (!cancelled) setState(next)
        },
        () => undefined
      )
    }, STATE_MS)
    return (): void => {
      cancelled = true
      stop()
      clearInterval(timer)
    }
  }, [])

  return { state, predictions, ranking }
}

/** A pair the Predictions page is to open on, handed from another page (Home's DETAILS). */
let wanted: string | null = null

export function openPredictionOf(pair: string): void {
  wanted = pair
}

export function takeWantedPrediction(): string | null {
  const pair = wanted
  wanted = null
  return pair
}
