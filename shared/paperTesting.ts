import { msg } from './i18n/translate'
import type { NewsConfig, NewsConfigPatch, NewsReaderHealth } from './news'
import type { BookStanding } from './paperBooks'

// START AND STOP PAPER TESTING (V8 Stage 9, 27 October 2026; the plan's Stage 9). Start runs V8's three paper books
// from that moment, each on its own 10,000 USDT, and switches on what they read -- each named in its confirmation:
// Binance's announcements read every minute, and the delisting rule's short with delistings put to the watch's models
// as the user chose on 5 October (the watch asks only while it is on, within its $5 day). The Monitoring Tag's bracket
// short is used where it is already on and left as it is; follows are the traders a person switched on; the baseline
// runs while the books do. Start writes paperBooks/started.json first, holding every switch it turned on and that
// switch's earlier value -- only those it changed -- and Stop puts each back exactly, whatever it was changed to since,
// and closes the books' open trades at the price then. Pure: electron/services/paperTestingService.ts reads and writes.

export const PAPER_TESTING_VERSION = 'paper-testing-v1'

/** The switches Start may turn on, by where they are kept. */
export const PAPER_TESTING_SWITCHES = ['news.enabled', 'news.delisting.paperShort', 'news.delisting.askModels'] as const
export type PaperTestingSwitch = (typeof PAPER_TESTING_SWITCHES)[number]

/** Each switch as a person reads it in Start's confirmation and in Stop's: keys, said in a language. */
export const PAPER_TESTING_SWITCH_NAMES: Record<PaperTestingSwitch, string> = {
  'news.enabled': msg("Binance's announcements, read every minute"),
  'news.delisting.paperShort': msg("The delisting rule's short, in the news book"),
  'news.delisting.askModels': msg("Delistings put to the watch's models, while the watch is on, within its $5 a day")
}

/** One switch Start turned on, and what it was before. */
export interface SwitchedOn {
  switch: PaperTestingSwitch
  was: boolean
}

/** paperBooks/started.json: the run Start began, and every switch it turned on with its earlier value. */
export interface StartedRecord {
  v: typeof PAPER_TESTING_VERSION
  startedAt: number
  switched: SwitchedOn[]
}

/** Whether each switch is on in the news reader's setting. */
export function switchStateOf(news: NewsConfig): Record<PaperTestingSwitch, boolean> {
  return { 'news.enabled': news.enabled, 'news.delisting.paperShort': news.delisting.paperShort.enabled, 'news.delisting.askModels': news.delisting.askModels }
}

/** The switches Start turns on: those off now, each with its earlier value. */
export function switchesToTurnOn(news: NewsConfig): SwitchedOn[] {
  const state = switchStateOf(news)
  return PAPER_TESTING_SWITCHES.filter((name) => !state[name]).map((name) => ({ switch: name, was: false }))
}

function patchOf(entries: readonly { switch: PaperTestingSwitch; on: boolean }[]): NewsConfigPatch {
  const patch: NewsConfigPatch = {}
  for (const entry of entries) {
    if (entry.switch === 'news.enabled') patch.enabled = entry.on
    if (entry.switch === 'news.delisting.paperShort') patch.delisting = { ...patch.delisting, paperShort: { enabled: entry.on } }
    if (entry.switch === 'news.delisting.askModels') patch.delisting = { ...patch.delisting, askModels: entry.on }
  }
  return patch
}

/** The news reader's patch that turns the switches Start turns on on. */
export function startPatchOf(switched: readonly SwitchedOn[]): NewsConfigPatch {
  return patchOf(switched.map((entry) => ({ switch: entry.switch, on: true })))
}

/** The patch that puts each switch Start turned on back to what it was before. */
export function restorePatchOf(switched: readonly SwitchedOn[]): NewsConfigPatch {
  return patchOf(switched.map((entry) => ({ switch: entry.switch, on: entry.was })))
}

/** A started.json as read, or null where it is not a whole one: a switch it does not know is not one to put back. */
export function readStartedRecord(value: unknown): StartedRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Partial<StartedRecord>
  if (raw.v !== PAPER_TESTING_VERSION || typeof raw.startedAt !== 'number' || !Number.isFinite(raw.startedAt) || raw.startedAt <= 0 || !Array.isArray(raw.switched)) return null
  const switched: SwitchedOn[] = []
  for (const entry of raw.switched as unknown[]) {
    const item = entry as Partial<SwitchedOn>
    if (typeof item !== 'object' || item === null || !(PAPER_TESTING_SWITCHES as readonly unknown[]).includes(item.switch) || typeof item.was !== 'boolean') return null
    if (switched.some((held) => held.switch === item.switch)) return null
    switched.push({ switch: item.switch as PaperTestingSwitch, was: item.was })
  }
  return { v: PAPER_TESTING_VERSION, startedAt: raw.startedAt, switched }
}

/** One finished run, as paperBooks/runs-YYYY-MM.jsonl keeps it: when it began and ended, what Start turned on, and what
 * Stop put back. */
export interface RunRecord {
  v: typeof PAPER_TESTING_VERSION
  startedAt: number
  stoppedAt: number
  switched: SwitchedOn[]
  restored: boolean
}

/** What the Paper testing card reads: whether the books run and since when, what Start turned on, each book's
 * standing, the switches as they are now, the announcement reader's health, and the traders followed and cloned. */
export interface PaperTestingState {
  running: boolean
  startedAt: number | null
  started: StartedRecord | null
  standings: BookStanding[]
  switches: Record<PaperTestingSwitch, boolean>
  tagShort: boolean
  reader: { lastReadAt: number | null; error: string | null; health: NewsReaderHealth }
  follows: number
  clones: number
}
