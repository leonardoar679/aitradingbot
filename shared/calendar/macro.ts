import calendar from './macro-2026.json'
import { MARKET_SHOCK_LINES } from '../forecast/marketShock'

// THE MACRO CALENDAR (V7.1 Stage 12, 16 October 2026): the U.S. releases that move every market at once --
// the Consumer Price Index, the Producer Price Index, the Employment Situation (the Bureau of Labor
// Statistics, 8:30 AM Eastern) and the FOMC statement (the Federal Reserve, 2:00 PM Eastern on the
// meeting's last day) -- compiled by research/fetch-macro-calendar.mjs from the public schedules into
// macro-2026.json, versioned data with no key. ETF decisions and token unlocks have no free, dated source
// and are left out. The calendar marks the market's PRE_EVENT state (shared/forecast/marketShock.ts) within
// the hour before a release, in training and live alike; it never moves a forecast's median: the surprise
// is the market's own reaction, read as Bitcoin's fifteen minutes after (POST_EVENT_SHOCK).
//
// IT IS DATA. No key, no model, no order, nothing read from anywhere at run time.

export const MACRO_CALENDAR_VERSION = 'macro-calendar-v1'

export const MACRO_KINDS = ['CPI', 'PPI', 'JOBS', 'FOMC'] as const
export type MacroKind = (typeof MACRO_KINDS)[number]

export interface MacroEvent {
  kind: MacroKind
  /** The release in words, and the month it reports on where the schedule says. */
  name: string
  reference?: string
  /** The release day (UTC date of the Eastern day) and its Eastern time, and the moment in Unix seconds. */
  date: string
  timeEt: string
  at: number
}

interface CalendarFile {
  version: string
  year: number
  readAt: string
  events: MacroEvent[]
}

const FILE = calendar as CalendarFile

/** Every release of the file, oldest first; empty where the file is not of this version. */
export const MACRO_EVENTS: readonly MacroEvent[] = FILE.version === MACRO_CALENDAR_VERSION ? [...FILE.events].filter((event) => (MACRO_KINDS as readonly string[]).includes(event.kind) && Number.isFinite(event.at)).sort((a, b) => a.at - b.at) : []

/** When the calendar was read from its sources. */
export const MACRO_CALENDAR_READ_AT: string = FILE.readAt

/** The window before a release the market is in PRE_EVENT: this many seconds. */
export const PRE_EVENT_SEC = MARKET_SHOCK_LINES.preEventMinutes * 60

/** The release a moment falls in the hour before -- from an hour before it up to the release itself, not
 * at it -- or null; the nearest where two overlap. */
export function releaseAhead(tSec: number, events: readonly MacroEvent[] = MACRO_EVENTS): MacroEvent | null {
  let found: MacroEvent | null = null
  for (const event of events) {
    if (event.at <= tSec) continue
    if (event.at - tSec > PRE_EVENT_SEC) break
    if (found === null || event.at < found.at) found = event
  }
  return found
}

/** Whether a moment is within the hour before a scheduled release: the market's PRE_EVENT state. */
export function preEventAt(tSec: number, events: readonly MacroEvent[] = MACRO_EVENTS): boolean {
  return releaseAhead(tSec, events) !== null
}

/** The releases from `fromSec` to `toSec`, both inclusive, oldest first. */
export function releasesBetween(fromSec: number, toSec: number, events: readonly MacroEvent[] = MACRO_EVENTS): MacroEvent[] {
  return events.filter((event) => event.at >= fromSec && event.at <= toSec)
}

/** The next `count` releases at or after a moment. */
export function nextReleases(tSec: number, count: number, events: readonly MacroEvent[] = MACRO_EVENTS): MacroEvent[] {
  return events.filter((event) => event.at >= tSec).slice(0, count)
}
