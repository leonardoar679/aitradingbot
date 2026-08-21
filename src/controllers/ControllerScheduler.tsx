import { useEffect, useRef, useState } from 'react'
import { computeExecutorPnl, executorAllocatedQuote } from '../executors/computeSnapshot'
import { handOverPositionOnStop } from '../executors/handOverPosition'
import { pushControllerSnapshot, getControllerSnapshots } from './controllerStore'
import { SNAPSHOT_INTERVAL_MS } from './types'
import type { ControllerConfig, ExecutorConfig } from '../../shared/ipc'

/** One snapshot tick: sums P&L + allocated capital across the controller's still-existing
 * attached executors, pushes a session snapshot, and checks risk controls against it. Shared by
 * the scheduled interval below and the ControllersPage "Run Snapshot Now" button. Risk-control
 * percentages are read against total allocated capital, not the raw P&L number, since P&L has no
 * natural zero-point to take a percentage of. */
export async function runControllerSnapshotNow(controller: ControllerConfig): Promise<void> {
  const settings = await window.api.settings.get()
  const attached = settings.executors.filter((e) => controller.executorIds.includes(e.id) && e.status === 'active')
  if (attached.length === 0) throw new Error('No active executors attached to this controller')

  // A failed P&L fetch must not silently become a fabricated 0 — this aggregate feeds both the
  // displayed snapshot and the stop-loss/take-profit/max-drawdown breach checks below, so a
  // wrong 0 could mask a real loss (suppressing a breach) or fake one (stopping executors on bad
  // data). Better to skip the tick entirely and surface the failure than act on unknown P&L.
  const results = await Promise.allSettled(attached.map((e) => computeExecutorPnl(e)))
  const failedNames = results.flatMap((r, i) => (r.status === 'rejected' ? [attached[i].name] : []))
  if (failedNames.length > 0) {
    throw new Error(`Could not compute P&L for: ${failedNames.join(', ')} — snapshot skipped, risk controls not evaluated this tick`)
  }
  const pnls = (results as PromiseFulfilledResult<number>[]).map((r) => r.value)
  const aggregatePnlQuote = pnls.reduce((sum, p) => sum + p, 0)
  const totalAllocatedQuote = attached.reduce((sum, e) => sum + executorAllocatedQuote(e), 0)
  const now = Math.floor(Date.now() / 1000)

  pushControllerSnapshot({ id: crypto.randomUUID(), controllerId: controller.id, takenAt: now, aggregatePnlQuote, executorCount: attached.length })

  const history = getControllerSnapshots(controller.id)
  const peak = history.reduce((max, s) => Math.max(max, s.aggregatePnlQuote), aggregatePnlQuote)
  const drawdownPct = peak > 0 ? ((peak - aggregatePnlQuote) / peak) * 100 : 0
  const pnlPct = totalAllocatedQuote > 0 ? (aggregatePnlQuote / totalAllocatedQuote) * 100 : 0

  const { riskControls } = controller
  const stopLossBreached = riskControls.globalStopLossPct !== null && pnlPct <= -Math.abs(riskControls.globalStopLossPct)
  const takeProfitBreached = riskControls.globalTakeProfitPct !== null && pnlPct >= Math.abs(riskControls.globalTakeProfitPct)
  const drawdownBreached = riskControls.maxDrawdownPct !== null && drawdownPct >= Math.abs(riskControls.maxDrawdownPct)

  if (stopLossBreached || takeProfitBreached || drawdownBreached) {
    const attachedIds = new Set(attached.map((e) => e.id))
    const stoppedAt = now
    // Re-read immediately before writing rather than reusing the snapshot taken at the top of
    // this function: computing P&L above does a network fetch per attached executor and can take
    // seconds, and writing whole arrays built from a stale read would silently revert anything
    // saved in the meantime (a newly created executor, an edited controller). The breach action
    // itself is narrow -- stop the attached executors and this controller -- so it applies just as
    // correctly to a fresh copy.
    const fresh = await window.api.settings.get()
    const nextExecutors = fresh.executors.map((e: ExecutorConfig) => (attachedIds.has(e.id) ? { ...e, status: 'stopped' as const, stoppedAt } : e))
    const nextControllers = fresh.controllers.map((c) => (c.id === controller.id ? { ...c, status: 'stopped' as const } : c))
    await window.api.settings.set({ executors: nextExecutors, controllers: nextControllers })

    // Honour "Keep position when stopped" here too. A controller stop used to skip handover
    // entirely, so whether that ticked checkbox was respected depended on who pressed stop --
    // and a risk-control breach is exactly when a still-open position most needs recording
    // rather than silently discarding. Runs after the stop is persisted (the stop is the urgent
    // part; each handover costs a candle fetch) and sequentially, because each one re-reads and
    // rewrites the whole heldPositions array.
    for (const executor of attached) {
      try {
        await handOverPositionOnStop(executor)
      } catch (error) {
        console.error(`Failed to hand over position for ${executor.name} on controller stop:`, error)
      }
    }
  }
}

const CONFIG_POLL_MS = 10_000

/** Headless — mounted once in App.tsx, same pattern as RoutineScheduler: no cross-component push
 * channel, so it polls settings.controllers to notice config changes made on ControllersPage. */
export function ControllerScheduler(): null {
  const [controllers, setControllers] = useState<ControllerConfig[]>([])
  const controllersRef = useRef<ControllerConfig[]>([])
  const lastSerializedRef = useRef<string>('')

  useEffect(() => {
    let cancelled = false
    async function poll(): Promise<void> {
      try {
        const settings = await window.api.settings.get()
        if (cancelled) return
        const serialized = JSON.stringify(settings.controllers)
        if (serialized !== lastSerializedRef.current) {
          lastSerializedRef.current = serialized
          setControllers(settings.controllers)
        }
      } catch (error) {
        console.error('Failed to poll controller settings:', error)
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
    controllersRef.current = controllers
  }, [controllers])

  useEffect(() => {
    const timers = controllers
      .filter((c) => c.status === 'active')
      .map((controller) =>
        setInterval(() => {
          const current = controllersRef.current.find((c) => c.id === controller.id)
          if (!current || current.status !== 'active') return
          runControllerSnapshotNow(current).catch((error) => console.error(`Controller "${controller.name}" snapshot failed:`, error))
        }, SNAPSHOT_INTERVAL_MS)
      )

    return () => {
      for (const timer of timers) clearInterval(timer)
    }
  }, [controllers])

  return null
}
