import * as electron from 'electron'
import { ALERT_KIND_SEVERITY, ALERT_THREAD_SECONDS, healAlertKind, healAlerts, healNoticeSeverity, noticeSeverity, threadKey, threadStep, type AlertKind, type AlertSeverity, type AlertThread } from '../../shared/alerts'
import { IpcChannel } from '../../shared/ipc'
import { soundFor, type NoticeSound } from '../../shared/sounds'
import { appendAlert, readAlertsSince } from './recordStoreService'
import { getSettings } from './settingsService'

// EVERY DESKTOP NOTICE THE APP RAISES COMES THROUGH HERE (the V4 document, §47-49): from the window
// through app:notify (electron/ipc/handlers/appHandlers.ts), and from the main process's own loops --
// a real position's watcher, the live loss limit, the exchange's health, the scanner, the stream, the
// feeds, the AI budget and key.
//
// What one notice does, in order:
// - A THREAD: a notice with a kind and a thread (a pair, an event, a trade, or a fixed name) is told
//   once per thread per half hour (shared/alerts.ts threadStep); a repeat inside the window is
//   counted on the thread and raises nothing. A pump that raises an event every minute is one
//   notice, then quiet.
// - THE RECORD: what is told is written to the alerts file (shared/records.ts) and sent to the
//   window, whatever the desktop can show, so that Overview's major alerts and the session report
//   hold it after a restart. A notice the Notifications control hides is still a record.
// - THE DESKTOP: the Notifications control is obeyed -- off, nothing is shown, and with the desktop's
//   notices off (V6 Stage 13) it is recorded, shown in the window and heard, but not on the desktop.
//   It is always SILENT there: since V6 Stage 13 the window plays the sound its meaning chose
//   (shared/sounds.ts, src/sound/), which the record carries, so the app's sound is the only one.
//   CRITICAL flashes the taskbar entry until the window is focused. Clicking one brings the window
//   back and does nothing else.
//
// Electron is imported as a namespace: a test that fakes none of it still loads whatever tells a
// notice, and the notice fails inside its own try.
//
// It never throws: a desktop that cannot show a notice, or a file that cannot be written, is not a
// reason to fail the pass, the watcher or the gate that raised it.

type WebContents = electron.WebContents

export interface NoticeRequest {
  title: string
  body: string
  severity: 'watch' | 'high' | 'critical' | null
  kind: AlertKind | null
  thread: string | null
  threadSeconds: number | null
  id: string | null
  url: string | null
  /** The sound it makes, where chosen where it was raised (shared/sounds.ts). */
  sound: NoticeSound | null
}

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : null)

/** A request as the window sends it, read as one; null for one with no text to show. */
export function healNoticeRequest(title: unknown, body: unknown, severity?: unknown, extra?: unknown): NoticeRequest | null {
  const heading = text(title, 120)
  const detail = text(body, 400)
  if (heading === null || detail === null) return null
  const raw = (typeof extra === 'object' && extra !== null ? extra : {}) as Record<string, unknown>
  const seconds = typeof raw.threadSeconds === 'number' && Number.isFinite(raw.threadSeconds) && raw.threadSeconds > 0 ? Math.floor(raw.threadSeconds) : null
  const url = text(raw.url, 500)
  return {
    title: heading,
    body: detail,
    severity: healNoticeSeverity(severity) ?? healNoticeSeverity(raw.severity),
    kind: healAlertKind(raw.kind),
    thread: text(raw.thread, 200),
    threadSeconds: seconds,
    id: text(raw.id, 200),
    url: url !== null && /^https:\/\//.test(url) ? url : null,
    sound: raw.sound === 'information' || raw.sound === 'opportunity' || raw.sound === 'warning' || raw.sound === 'critical' || raw.sound === 'none' ? raw.sound : null
  }
}

let threads: Record<string, AlertThread> = {}
/** Notifications on screen. Held because one that has been garbage-collected cannot be clicked. */
const shown = new Set<electron.Notification>()

/** The threads told in the last day, read back from the alerts file once before the first notice
 * (V5 Stage 8, 8 October 2026): a daily thread -- a degraded model or strategy, the budget -- was
 * forgotten with the process, so a restart told it again. A record on file now counts as its thread's
 * first telling. A file that cannot be read seeds nothing. */
let seeded: Promise<void> | null = null
function seedThreads(): Promise<void> {
  if (seeded === null) {
    try {
      seeded = readAlertsSince({ sinceSec: Math.floor(Date.now() / 1000) - ALERT_THREAD_SECONDS * 48 })
        .then((page) => {
          for (const row of page.rows) {
            if (row.kind === undefined || row.thread === undefined) continue
            const key = threadKey(row.kind, row.thread)
            const held = threads[key]
            if (held === undefined) threads[key] = { count: 1, firstAt: row.at, lastAt: row.at }
            else if (row.at < held.firstAt) threads[key] = { ...held, firstAt: row.at }
          }
        })
        .catch(() => undefined)
    } catch {
      seeded = Promise.resolve()
    }
  }
  return seeded
}

/** The minute's reminder for a CRITICAL banner still up (the V5 document, §49): whether it may sound --
 * notices on, whatever the sound switch says, CRITICAL being heard regardless (V6 Stage 13). Nothing is
 * shown or recorded -- the notice itself was -- and the window plays the critical sound itself
 * (src/news/AlertBanner.tsx, src/sound/player.ts): the main process no longer beeps. */
export async function remind(): Promise<boolean> {
  try {
    return (await alertsControl()).enabled
  } catch {
    return false
  }
}

/** The Notifications control (shared/alerts.ts), read as this service obeys it: the one place it
 * reads a setting. */
async function alertsControl(): Promise<ReturnType<typeof healAlerts>> {
  return healAlerts((await getSettings()).alerts)
}

/** How loud a notice without a severity of its own is: by its kind, else as HIGH, which sounds. */
export function noticeLevel(request: Pick<NoticeRequest, 'severity' | 'kind'>): 'watch' | 'high' | 'critical' {
  if (request.severity !== null) return request.severity
  const byKind = request.kind === null ? null : noticeSeverity(ALERT_KIND_SEVERITY[request.kind])
  return byKind ?? 'high'
}

/** The window to bring back on a click: the one the notice came from, else the first. */
function windowFor(sender: WebContents | null): electron.BrowserWindow | null {
  const own = sender === null ? null : electron.BrowserWindow.fromWebContents(sender)
  if (own && !own.isDestroyed()) return own
  const first = electron.BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  return first ?? null
}

/** Tells one notice. Resolves true when the desktop showed it; false when it was a repeat on its
 * thread, when notices are off, or when the desktop cannot show one. The record and the window are
 * told in every case but the repeat. */
export async function tellNotice(request: NoticeRequest | null, sender: WebContents | null = null): Promise<boolean> {
  if (request === null) return false
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    if (request.kind !== null && request.thread !== null) {
      await seedThreads()
      const step = threadStep(threads, request.kind, request.thread, nowSec, request.threadSeconds ?? undefined)
      threads = step.threads
      if (step.repeat) return false
    }
    const level = noticeLevel(request)
    const severity: AlertSeverity = level
    const record = {
      id: request.id ?? `${request.kind ?? 'notice'}:${request.thread ?? 'none'}:${Date.now()}`,
      at: nowSec,
      severity,
      title: request.title,
      body: request.body,
      ...(request.url !== null ? { url: request.url } : {}),
      ...(request.kind !== null ? { kind: request.kind } : {}),
      ...(request.thread !== null ? { thread: request.thread } : {}),
      // The sound its meaning makes, which the window plays: chosen where it was raised, else its kind's.
      sound: soundFor({ sound: request.sound, kind: request.kind, severity }) ?? 'none'
    }
    const written = await appendAlert(record).catch((error: unknown) => {
      console.error('The alert could not be written:', error)
      return null
    })
    for (const win of electron.BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IpcChannel.AlertsTold, written ?? record)
    }

    if (!electron.Notification.isSupported()) return false
    const alerts = await alertsControl()
    if (!alerts.enabled || alerts.desktop === false) return false
    // Silent: the window plays the sound (src/sound/), so that the app's own is the only one heard.
    const notification = new electron.Notification({ title: request.title, body: request.body, silent: true })
    shown.add(notification)
    const forget = (): void => void shown.delete(notification)
    notification.on('close', forget)
    notification.on('failed', forget)
    notification.on('click', () => {
      forget()
      const window = windowFor(sender)
      if (window === null) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
    notification.show()
    if (level === 'critical') {
      const window = windowFor(sender)
      if (window !== null && !window.isFocused()) {
        window.flashFrame(true)
        window.once('focus', () => {
          if (!window.isDestroyed()) window.flashFrame(false)
        })
      }
    }
    return true
  } catch (error) {
    console.error('A notice could not be told:', error)
    return false
  }
}

/** Tells a notice built by shared/notices.ts: its text and its extra, from the main process's own
 * loops. Never throws. */
export function tell(notice: { title: string; body: string; extra: { severity?: 'watch' | 'high' | 'critical'; kind: AlertKind; thread?: string; threadSeconds?: number; id?: string; url?: string; sound?: NoticeSound } }): void {
  void tellNotice(healNoticeRequest(notice.title, notice.body, notice.extra.severity, notice.extra))
}

/** Test seam: forgets every thread, and reads the file again before the next notice. */
export function resetNoticeThreads(): void {
  threads = {}
  seeded = null
}
