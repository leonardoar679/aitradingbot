import { useEffect, useRef, useState } from 'react'
import { runBacktest } from '../backtest/engine'
import { getStrategy } from '../backtest/strategies'
import { INTERVAL_SECONDS } from '../../shared/ipc'
import { pushRoutineReport } from './routineStore'
import { schedulingSignature } from './schedulingSignature'
import { settingsWrites } from '../utils/settingsWrites'
import type { RoutineConfig } from '../../shared/ipc'

const LOOKBACK_SEC = 90 * 24 * 3600 // matches BacktestPage's default 90-day window

/** The routine's 90 days of results, PLUS however much history its strategy needs before it can
 * trade at all.
 *
 * The 90 days used to be the whole fetch, which silently meant "90 days minus the warm-up" of
 * actual measurement. That was invisible while every strategy warmed up in 200 bars, and became
 * the whole window the moment one needed 80 days: a daily routine on Trend Regime Ensemble had 10
 * tradeable days left and reported "0 trades" forever, which reads as a broken strategy rather
 * than a too-short window. A routine is a repeated measurement, so the measured span has to be
 * the same 90 days for every strategy. */
function fetchStartSec(nowSec: number, routine: RoutineConfig): number {
  const barSec = INTERVAL_SECONDS[routine.interval]
  const warmupSec = getStrategy(routine.strategyId).warmupBarsFor(barSec) * barSec
  return nowSec - LOOKBACK_SEC - warmupSec
}


/** Fetches the routine's window, runs the backtest engine, pushes a report, and stamps
 * lastRunAt — shared by the scheduled timer below and the RoutinesPage "Run Now" button. */
export async function runRoutineNow(routine: RoutineConfig): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000)
  const startSec = fetchStartSec(nowSec, routine)
  const { candles } = await window.api.market.fetchHistoricalRange(routine.exchange, routine.symbol, routine.interval, startSec, nowSec)
  if (candles.length === 0) throw new Error('No candle data available for this window yet')

  // Deliberately the engine default, not the paper account balance the Backtest page uses. A
  // routine is a repeated measurement: its saved reports are read side by side to see whether a
  // strategy is holding up, and re-basing each run on whatever the account happened to hold that
  // day would make consecutive reports' currency figures incomparable for a reason that has
  // nothing to do with the strategy. A fixed yardstick is the point.
  const result = runBacktest(candles, routine.strategyId)
  pushRoutineReport({ id: crypto.randomUUID(), routineId: routine.id, ranAt: nowSec, symbolLabel: routine.symbol, result })

  await settingsWrites(async () => {
    const settings = await window.api.settings.get()
    const nextRoutines = settings.routines.map((r) => (r.id === routine.id ? { ...r, lastRunAt: nowSec } : r))
    await window.api.settings.set({ routines: nextRoutines })
  })
}

/** Headless — mounted once in App.tsx so schedules keep firing regardless of which page is
 * active. Reads settings.routines and keeps one setInterval per enabled routine.
 *
 * Intervals run from when this mounted, not from each routine's lastRunAt, so a routine only ever
 * fires if the app stays open for a full period of it -- an hourly routine will not fire in a
 * half-hour session, however long ago it last ran. That is a property of scheduling inside a
 * desktop app that has to be running to do anything, and is left as is; the bug fixed here was
 * the different one where the interval never got the chance to elapse at all. */
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
        // Compared on scheduling fields only. Including lastRunAt here made every completed run
        // look like a config edit, which rebuilt every routine's interval from zero and starved
        // any routine slower than the fastest one -- see schedulingSignature.
        const signature = schedulingSignature(settings.routines)
        if (signature !== lastSerializedRef.current) {
          lastSerializedRef.current = signature
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
