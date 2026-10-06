import type { AlertSeverity } from '../../shared/alerts'

// The alerts raised this session (src/news/NewsAlertScheduler.tsx): what the sidebar's badge
// counts and the banner shows. Kept for the session only: a restart does not raise old news again.

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
