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

/** Whether a snapshot has ever been computed this session. An empty snapshot list on its own
 * can't say -- "still working on the first one" and "computed it, you hold nothing" produce the
 * same empty list but must not produce the same display. The first snapshot needs settings, live
 * positions, a candle replay per executor, a 600-candle dry run per bot and a ticker per symbol,
 * so on a slow link "loading" is a state the user really sits in. */
export type PortfolioStatus = 'loading' | 'ready' | 'error'

let snapshots: PortfolioSnapshot[] = []
let status: PortfolioStatus = 'loading'
let errorMessage: string | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function pushPortfolioSnapshot(data: PortfolioSnapshotData): void {
  const snapshot: PortfolioSnapshot = { ...data, id: crypto.randomUUID(), takenAt: Math.floor(Date.now() / 1000) }
  // Oldest-first (unlike ControllerSnapshot's newest-first convention) -- the Evolution chart
  // plots this directly as a time series and shouldn't have to reverse it first.
  snapshots = [...snapshots, snapshot].slice(-MAX_SNAPSHOTS)
  status = 'ready'
  errorMessage = null
  emit()
}

/** Only moves the page into an error state while nothing has ever been computed. Once a real
 * snapshot exists, a later failed poll leaves the last known figures on screen rather than
 * replacing them with an error -- stale-but-real beats blank. */
export function setPortfolioError(message: string): void {
  if (snapshots.length === 0) status = 'error'
  errorMessage = message
  emit()
}

export function getPortfolioSnapshots(): PortfolioSnapshot[] {
  return snapshots
}

/** Exported as plain getters, not just through the hooks below, so the status machine can be
 * tested without a React renderer -- the hooks are thin wrappers over exactly these. */
export function getPortfolioStatus(): PortfolioStatus {
  return status
}

export function getPortfolioErrorMessage(): string | null {
  return errorMessage
}

export function subscribeToPortfolio(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePortfolioSnapshots(): PortfolioSnapshot[] {
  return useSyncExternalStore(subscribeToPortfolio, getPortfolioSnapshots)
}

export function usePortfolioStatus(): PortfolioStatus {
  return useSyncExternalStore(subscribeToPortfolio, getPortfolioStatus)
}

export function usePortfolioErrorMessage(): string | null {
  return useSyncExternalStore(subscribeToPortfolio, getPortfolioErrorMessage)
}

export function useLatestPortfolioSnapshot(): PortfolioSnapshot | null {
  const all = usePortfolioSnapshots()
  return all.length > 0 ? all[all.length - 1] : null
}
