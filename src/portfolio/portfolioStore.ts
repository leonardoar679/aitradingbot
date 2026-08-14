import { useSyncExternalStore } from 'react'
import type { PortfolioSnapshotData } from './computePortfolioSnapshot'

// Session-only, same reasoning as ControllerSnapshot/RoutineReport -- a value snapshot every
// couple of minutes, persisted for the app's lifetime, would grow settings.json unboundedly over
// long sessions. Nothing here survives a restart, and nothing is ever backfilled to make it look
// otherwise -- the chart that reads this starts empty and fills in from whenever the app starts
// tracking it.
const MAX_SNAPSHOTS = 1000

export interface PortfolioSnapshot extends PortfolioSnapshotData {
  id: string
  takenAt: number
}

let snapshots: PortfolioSnapshot[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function pushPortfolioSnapshot(data: PortfolioSnapshotData): void {
  const snapshot: PortfolioSnapshot = { ...data, id: crypto.randomUUID(), takenAt: Math.floor(Date.now() / 1000) }
  // Oldest-first (unlike ControllerSnapshot's newest-first convention) -- the Evolution chart
  // plots this directly as a time series and shouldn't have to reverse it first.
  snapshots = [...snapshots, snapshot].slice(-MAX_SNAPSHOTS)
  emit()
}

export function getPortfolioSnapshots(): PortfolioSnapshot[] {
  return snapshots
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePortfolioSnapshots(): PortfolioSnapshot[] {
  return useSyncExternalStore(subscribe, getPortfolioSnapshots)
}

export function useLatestPortfolioSnapshot(): PortfolioSnapshot | null {
  const all = usePortfolioSnapshots()
  return all.length > 0 ? all[all.length - 1] : null
}
