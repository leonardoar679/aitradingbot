import { DEFAULT_ALERTS } from '../../shared/alerts'
import type { AlertSettings } from '../../shared/ipc'
import type { AlertRecordOnFile } from '../../shared/records'
import { DEFAULT_SOUND_SETTINGS, TOP_CHANGE_CHIME_SECONDS, shouldPlay, soundFor, type SoundName, type SoundSettings } from '../../shared/sounds'
import { playSound } from './player'

// WHICH NOTICE IS HEARD, AND SEEN (the V6 document, §72-80; V6 Stage 13). Every notice the app tells comes
// back to the window as it is told (window.api.records.onTold); here its sound is chosen -- the one the
// record carries, chosen where it was raised, else its kind's (shared/sounds.ts) -- and played under the
// controls, and it is shown as a toast (./NoticeToasts.tsx) whether or not it sounds: never sound alone.
// CRITICAL is shown by the banner (src/news/AlertBanner.tsx), and heard whatever the controls say but
// notices off.

export interface SoundPrefs {
  alerts: AlertSettings
  sounds: SoundSettings
}

let prefs: SoundPrefs = { alerts: DEFAULT_ALERTS, sounds: DEFAULT_SOUND_SETTINGS }
const lastPlayedMs: Partial<Record<SoundName, number>> = {}

export function setSoundPrefs(next: SoundPrefs): void {
  prefs = next
}

export function soundPrefs(): SoundPrefs {
  return prefs
}

/** The sound a told notice makes: the one on its record, else its kind's. */
export function soundOfRecord(record: Pick<AlertRecordOnFile, 'sound' | 'kind' | 'severity'>): SoundName | null {
  if (record.sound !== undefined) return record.severity === 'critical' ? 'critical' : record.sound === 'none' ? null : record.sound
  return soundFor({ kind: record.kind ?? null, severity: record.severity })
}

/** Plays a told notice's sound if the controls let it; what was played, or why not. */
export function hearNotice(
  record: Pick<AlertRecordOnFile, 'sound' | 'kind' | 'severity'>,
  now: Date = new Date(),
  play: (name: SoundName, volume: number) => boolean = playSound
): { played: SoundName | null; why: string | null } {
  const sound = soundOfRecord(record)
  const decision = shouldPlay({ sound, kind: record.kind ?? null, alerts: prefs.alerts, settings: prefs.sounds, hourOfDay: now.getHours(), nowMs: now.getTime(), lastPlayedMs })
  if (!decision.play || sound === null) return { played: null, why: decision.why }
  play(sound, prefs.sounds.volume)
  lastPlayedMs[sound] = now.getTime()
  return { played: sound, why: null }
}

/** The chime for the top prediction changing pair (§72): at most once in half an hour. */
let lastTop: { pair: string; chimedAt: number } | null = null

export function topPredictionChime(pair: string | null, nowSec: number): boolean {
  if (pair === null) return false
  if (lastTop === null) {
    // The first ranking read is where things stand, not a change.
    lastTop = { pair, chimedAt: Number.NEGATIVE_INFINITY }
    return false
  }
  if (pair === lastTop.pair) return false
  const due = nowSec - lastTop.chimedAt >= TOP_CHANGE_CHIME_SECONDS
  lastTop = { pair, chimedAt: due ? nowSec : lastTop.chimedAt }
  return due
}

/** Test seam. */
export function resetNoticeSounds(): void {
  prefs = { alerts: DEFAULT_ALERTS, sounds: DEFAULT_SOUND_SETTINGS }
  for (const key of Object.keys(lastPlayedMs)) delete lastPlayedMs[key as SoundName]
  lastTop = null
}
