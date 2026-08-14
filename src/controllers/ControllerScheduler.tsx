import { useEffect, useRef, useState } from 'react'
import { computeExecutorPnl, executorAllocatedQuote } from '../executors/computeSnapshot'
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

  const pnls = await Promise.all(
    attached.map((e) =>
      computeExecutorPnl(e).catch((error) => {
        console.error(`Failed to compute P&L for executor "${e.name}":`, error)
        return 0
      })
    )
  )
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
    const nextExecutors = settings.executors.map((e: ExecutorConfig) => (attachedIds.has(e.id) ? { ...e, status: 'stopped' as const, stoppedAt } : e))
    const nextControllers = settings.controllers.map((c) => (c.id === controller.id ? { ...c, status: 'stopped' as const } : c))
    await window.api.settings.set({ executors: nextExecutors, controllers: nextControllers })
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
