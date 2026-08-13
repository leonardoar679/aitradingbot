import { useEffect, useRef, useState } from 'react'
import { runBacktest } from '../backtest/engine'
import { pushRoutineReport } from './routineStore'
import type { RoutineConfig } from '../../shared/ipc'

const LOOKBACK_SEC = 90 * 24 * 3600 // matches BacktestPage's default 90-day window

/** Fetches the routine's window, runs the backtest engine, pushes a report, and stamps
 * lastRunAt — shared by the scheduled timer below and the RoutinesPage "Run Now" button. */
export async function runRoutineNow(routine: RoutineConfig): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000)
  const startSec = nowSec - LOOKBACK_SEC
  const { candles } = await window.api.market.fetchHistoricalRange(routine.exchange, routine.symbol, routine.interval, startSec, nowSec)
  if (candles.length === 0) return

  const result = runBacktest(candles, routine.strategyId)
  pushRoutineReport({ id: crypto.randomUUID(), routineId: routine.id, ranAt: nowSec, symbolLabel: routine.symbol, result })

  const settings = await window.api.settings.get()
  const nextRoutines = settings.routines.map((r) => (r.id === routine.id ? { ...r, lastRunAt: nowSec } : r))
  await window.api.settings.set({ routines: nextRoutines })
}

/** Headless — mounted once in App.tsx so schedules keep firing regardless of which page is
 * active. Reads settings.routines and keeps one setInterval per enabled routine. */
const CONFIG_POLL_MS = 10_000

export function RoutineScheduler(): null {
  const [routines, setRoutines] = useState<RoutineConfig[]>([])
  const routinesRef = useRef<RoutineConfig[]>([])
  const lastSerializedRef = useRef<string>('')

  // RoutinesPage manages its own local copy of settings.routines (same pattern as
  // Bots/Executors pages) with no cross-component push channel, so this instance — mounted
  // once, for the app's whole lifetime — has to poll to notice config changes made there.
  useEffect(() => {
    let cancelled = false
    async function poll(): Promise<void> {
      try {
        const settings = await window.api.settings.get()
        if (cancelled) return
        const serialized = JSON.stringify(settings.routines)
        if (serialized !== lastSerializedRef.current) {
          lastSerializedRef.current = serialized
          setRoutines(settings.routines)
        }
      } catch (error) {
        console.error('Failed to poll routine settings:', error)
      }
    }
    void poll()
    const timer = setInterval(poll, CONFIG_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    routinesRef.current = routines
  }, [routines])

  useEffect(() => {
    const timers = routines
      .filter((r) => r.enabled)
      .map((routine) =>
        setInterval(() => {
          const current = routinesRef.current.find((r) => r.id === routine.id)
          if (!current || !current.enabled) return
          runRoutineNow(current).catch((error) => console.error(`Routine "${routine.name}" failed:`, error))
        }, routine.scheduleSec * 1000)
      )

    return () => {
      for (const timer of timers) clearInterval(timer)
    }
  }, [routines])

  return null
}
