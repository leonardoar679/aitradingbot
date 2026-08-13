import { useSyncExternalStore } from 'react'
import type { ControllerSnapshot } from './types'

const MAX_SNAPSHOTS_PER_CONTROLLER = 50

let snapshotsByController: Record<string, ControllerSnapshot[]> = {}
const listeners = new Set<() => void>()
const EMPTY_SNAPSHOTS: ControllerSnapshot[] = []

function emit(): void {
  for (const listener of listeners) listener()
}

export function pushControllerSnapshot(snapshot: ControllerSnapshot): void {
  const existing = snapshotsByController[snapshot.controllerId] ?? []
  snapshotsByController = {
    ...snapshotsByController,
    [snapshot.controllerId]: [snapshot, ...existing].slice(0, MAX_SNAPSHOTS_PER_CONTROLLER)
  }
  emit()
}

export function getControllerSnapshots(controllerId: string): ControllerSnapshot[] {
  return snapshotsByController[controllerId] ?? EMPTY_SNAPSHOTS
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useControllerSnapshots(controllerId: string): ControllerSnapshot[] {
  return useSyncExternalStore(subscribe, () => getControllerSnapshots(controllerId))
}
