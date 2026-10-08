import type { AlertSeverity } from '../../shared/alerts'
import type { AlertRecordOnFile } from '../../shared/records'

// The alerts raised this session (src/news/NewsAlertScheduler.tsx): what the sidebar's badge
// counts and the banner shows. Kept here for the session; since 8 October 2026 each is also written
// to a file by the scheduler (shared/records.ts), and the day's are read back on start as told --
// seen and dismissed already, so that a restart raises no old news again and Overview still shows
// the day's major alerts.

export interface AlertRecord {
  id: string
  severity: AlertSeverity
  title: string
  body: string
  /** Seconds. */
  at: number
  /** Opened on Discovery's news, which clears the badge. */
  seen: boolean
  /** A CRITICAL one stays as a banner until this. */
  dismissed: boolean
  url?: string
}

type Listener = (alerts: readonly AlertRecord[]) => void

const KEPT = 200
let alerts: AlertRecord[] = []
const listeners = new Set<Listener>()

function publish(): void {
  for (const listener of listeners) listener(alerts)
}

export function addAlert(alert: Omit<AlertRecord, 'seen' | 'dismissed'>): void {
  if (alerts.some((entry) => entry.id === alert.id)) return
  alerts = [{ ...alert, seen: alert.severity === 'info', dismissed: false }, ...alerts].slice(0, KEPT)
  publish()
}

/** Every alert so far seen: Discovery's news was opened. */
export function markAlertsSeen(): void {
  if (alerts.every((alert) => alert.seen)) return
  alerts = alerts.map((alert) => ({ ...alert, seen: true }))
  publish()
}

export function dismissAlert(id: string): void {
  alerts = alerts.map((alert) => (alert.id === id ? { ...alert, dismissed: true, seen: true } : alert))
  publish()
}

export function subscribeAlerts(listener: Listener): () => void {
  listeners.add(listener)
  listener(alerts)
  return () => void listeners.delete(listener)
}

/** Alerts at WATCH or above not yet seen: the badge. */
export function unseenCount(list: readonly AlertRecord[]): number {
  return list.filter((alert) => !alert.seen && alert.severity !== 'info').length
}

/** CRITICAL alerts not yet dismissed: the banner. */
export function bannerAlerts(list: readonly AlertRecord[]): AlertRecord[] {
  return list.filter((alert) => alert.severity === 'critical' && !alert.dismissed)
}

/** Alerts read back from the file on start: kept as told, seen and dismissed already. One already
 * held, by id, is left as it is. */
export function seedAlerts(records: readonly AlertRecordOnFile[]): void {
  const fresh = records.filter((record) => !alerts.some((entry) => entry.id === record.id)).map((record) => ({ ...record, seen: true, dismissed: true }))
  if (fresh.length === 0) return
  alerts = [...alerts, ...fresh].sort((a, b) => b.at - a.at).slice(0, KEPT)
  publish()
}

/** Test seam. */
export function resetAlerts(): void {
  alerts = []
  publish()
}
