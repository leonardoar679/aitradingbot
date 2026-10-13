import { useEffect, useState } from 'react'
import { riskModeOf, targetLevelOf } from '../../shared/appDefaults'
import { healForecastSettings } from '../../shared/forecast/training'
import type { TargetLevel } from '../../shared/forecast/tradePlan'
import { healPaperPause } from '../../shared/paperPause'
import { healPaperRisk } from '../../shared/paperRisk'

/** The level a trade plan's target is set at: the risk mode's (shared/appDefaults.ts), read from the
 * settings when a card opens. Conservative's P75 until read. */
export function useRiskTarget(): TargetLevel {
  const [level, setLevel] = useState<TargetLevel>('P75')
  useEffect(() => {
    let cancelled = false
    void window.api.settings.get().then(
      (settings) => {
        if (cancelled) return
        const mode = riskModeOf({ paperRisk: healPaperRisk(settings.paperRisk), paperPause: healPaperPause(settings.paperPause), trader: healForecastSettings(settings.forecast).trader })
        setLevel(targetLevelOf(mode))
      },
      () => undefined
    )
    return (): void => {
      cancelled = true
    }
  }, [])
  return level
}
