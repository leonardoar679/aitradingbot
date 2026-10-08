import { describeFrameAge, type LiveMarketState } from './liveMarketState'

// ALIVE AFTER THE WINDOW IS CLOSED (the V5 document, §98-99; V5 Stage 2, 8 October 2026).
//
// The document wants the engine alive whatever the window does. Everything that runs by itself
// in this app is mounted above every page (the renderer's schedulers) or in the main process (the
// scanner, the research, the feeds, the live socket, the position watchers), so it is alive on
// any page; and since 8 October 2026 the window is not throttled while minimized
// (`backgroundThrottling: false`, electron/main.ts). What ended it was closing the window, which
// quits the app on Windows and Linux.
//
// "Keep running when the window is closed" (Settings › Essentials) changes that: on, closing the
// window hides it to the tray, and the watch, its paper trades, the exit check and the live
// position watchers run on until Quit from the tray icon. It ships OFF (the user's choice of 8
// October 2026): a person who closes the app while the watch is on expects it to stop spending,
// and only `true` in the file switches it on.

export const DEFAULT_KEEP_RUNNING = false

/** A stored setting, read as one: settings.json is written by the renderer, so it is healed rather
 * than obeyed. Only `true` keeps the app running. */
export function healKeepRunning(value: unknown): boolean {
  return value === true
}

export type CloseAction = 'hide' | 'quit'

/** What closing the window does: hides it when the setting is on and nothing has asked to quit;
 * quits otherwise. A quit already asked for (the tray's Quit, the OS) is never turned into a hide. */
export function closeAction(keepRunningWhenClosed: boolean, quitting: boolean): CloseAction {
  return keepRunningWhenClosed && !quitting ? 'hide' : 'quit'
}

/** Windows shows at most 127 characters of a tray tooltip. */
export const TRAY_TOOLTIP_MAX_CHARS = 127

export interface TrayFacts {
  /** The live-price socket as it stands (shared/liveMarketState.ts). */
  state: LiveMarketState
  /** The age of its last frame, in milliseconds; null before the first. */
  ageMs: number | null
  watchOn: boolean
  /** The app's own paper trades open now. */
  ownOpen: number
  keepRunning: boolean
}

function describeSocket(state: LiveMarketState, ageMs: number | null): string {
  const age = ageMs === null ? 'no frame yet' : describeFrameAge(ageMs)
  switch (state) {
    case 'off':
      return 'LIVE MARKET OFF'
    case 'live':
      return `LIVE · ${age}`
    case 'quiet':
      return `QUIET ${age}`
    case 'stale':
      return `MARKET DATA STALE ${age}`
    case 'reconnecting':
      return 'RECONNECTING'
  }
}

/** The tray icon's tooltip: the socket, the watch, the app's own open paper trades, and what
 * closing the window does. */
export function trayTooltip(facts: TrayFacts): string {
  const trades = facts.ownOpen === 0 ? 'no own paper trade open' : facts.ownOpen === 1 ? '1 own paper trade open' : `${facts.ownOpen} own paper trades open`
  const text = `TraderSpider — ${describeSocket(facts.state, facts.ageMs)} · the watch ${facts.watchOn ? 'on' : 'off'} · ${trades} · ${facts.keepRunning ? 'keeps running when the window is closed' : 'quits when the window is closed'}`
  return text.length <= TRAY_TOOLTIP_MAX_CHARS ? text : `${text.slice(0, TRAY_TOOLTIP_MAX_CHARS - 1)}…`
}
