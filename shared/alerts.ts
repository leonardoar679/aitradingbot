import type { AlertSettings } from './ipc'

// THE APP'S DESKTOP NOTICES: WHETHER THEY ARE RAISED AT ALL, AND WITH SOUND.
//
// Everything that tells the desktop something -- a call from the watch, a paper trade opened or
// paused, the daily digest, an announcement about a coin held -- goes through one main-process
// handler (electron/ipc/handlers/appHandlers.ts), and that handler reads this setting before it
// shows anything. Since 6 October 2026 it is one of the six controls at the top of Settings, as the
// V3 document asks ("Notifications: Enabled"). On, with sound, until it is changed.

export const DEFAULT_ALERTS: AlertSettings = { enabled: true, sound: true }

/** A stored setting, read as one: settings.json is written by the renderer, so it is healed rather
 * than obeyed. Only `false` switches either off. */
export function healAlerts(value: unknown): AlertSettings {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Partial<Record<keyof AlertSettings, unknown>>
  return { enabled: raw.enabled !== false, sound: raw.sound !== false }
}
