import { useSyncExternalStore } from 'react'
import type { RoutineReport } from './types'

const MAX_REPORTS_PER_ROUTINE = 20

let reportsByRoutine: Record<string, RoutineReport[]> = {}
const listeners = new Set<() => void>()
// useSyncExternalStore requires a stable reference when nothing changed — a fresh `[]` literal
// on every call would fail that and loop.
const EMPTY_REPORTS: RoutineReport[] = []

function emit(): void {
  for (const listener of listeners) listener()
}

export function pushRoutineReport(report: RoutineReport): void {
  const existing = reportsByRoutine[report.routineId] ?? []
  reportsByRoutine = {
    ...reportsByRoutine,
    [report.routineId]: [report, ...existing].slice(0, MAX_REPORTS_PER_ROUTINE)
  }
  emit()
}

export function getRoutineReports(routineId: string): RoutineReport[] {
  return reportsByRoutine[routineId] ?? EMPTY_REPORTS
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRoutineReports(routineId: string): RoutineReport[] {
  return useSyncExternalStore(subscribe, () => getRoutineReports(routineId))
}
