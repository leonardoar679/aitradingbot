import { ALERT_KINDS, type AlertKind, type AlertSeverity } from './alerts'

// SOUNDS BY MEANING (the V6 document, §72-80 and §109-110; V6 Stage 13, 13 October 2026). Four sounds, each
// a fixed score -- its notes, its wave, its envelope -- played by the window (src/sound/player.ts), so that
// what a notice MEANS can be told by ear before it is read:
// - INFORMATION: a soft two-note chime, rising a sixth -- something to know;
// - OPPORTUNITY: three notes rising -- something to act on;
// - WARNING: two notes falling -- something going against you;
// - CRITICAL: a pulse of three, played again once a minute while its banner is up -- something to stop for.
// Each is short (under a second and a half), gentle (nothing above 2.5 kHz, an attack of at least five
// milliseconds, never louder than the volume), and told apart from the others by its shape.
//
// WHICH SOUND: where a notice is raised it may say (its `sound`); otherwise its kind and severity choose by
// one table. Not everything sounds (§72): a forecast made again, a trade refused, a model's disagreement
// or a degraded model are seen, not heard. A repeat on a notice's thread raises nothing, so plays nothing
// (§79). A notice that sounds is always shown too, never sound alone (§80).
//
// THE CONTROLS (§77-78): sound on or off, the volume, a kind muted, a cooldown between two of one sound,
// quiet hours. CRITICAL is heard whatever they say: only switching notices off altogether silences it.

export const SOUNDS = ['information', 'opportunity', 'warning', 'critical'] as const
export type SoundName = (typeof SOUNDS)[number]
/** What a notice may say where it is raised: one of the four, or none. */
export type NoticeSound = SoundName | 'none'

export interface Note {
  /** Hz. */
  freq: number
  /** Seconds from the sound's start, and long. */
  start: number
  duration: number
  /** Of the volume: 0 to 1. */
  gain: number
}

export interface SoundScore {
  name: SoundName
  wave: 'sine' | 'triangle'
  /** Seconds each note takes to rise to its gain, and to fall to silence after it. */
  attack: number
  release: number
  notes: Note[]
}

export const SOUND_SCORES: Record<SoundName, SoundScore> = {
  information: {
    name: 'information',
    wave: 'sine',
    attack: 0.01,
    release: 0.25,
    notes: [
      { freq: 783.99, start: 0, duration: 0.16, gain: 0.5 },
      { freq: 1318.51, start: 0.14, duration: 0.3, gain: 0.42 }
    ]
  },
  opportunity: {
    name: 'opportunity',
    wave: 'triangle',
    attack: 0.008,
    release: 0.2,
    notes: [
      { freq: 659.25, start: 0, duration: 0.12, gain: 0.55 },
      { freq: 783.99, start: 0.12, duration: 0.12, gain: 0.6 },
      { freq: 1046.5, start: 0.24, duration: 0.26, gain: 0.65 }
    ]
  },
  warning: {
    name: 'warning',
    wave: 'triangle',
    attack: 0.01,
    release: 0.22,
    notes: [
      { freq: 880, start: 0, duration: 0.2, gain: 0.7 },
      { freq: 587.33, start: 0.22, duration: 0.32, gain: 0.7 }
    ]
  },
  critical: {
    name: 'critical',
    wave: 'triangle',
    attack: 0.006,
    release: 0.08,
    notes: [
      { freq: 1174.66, start: 0, duration: 0.12, gain: 0.9 },
      { freq: 1174.66, start: 0.2, duration: 0.12, gain: 0.9 },
      { freq: 1174.66, start: 0.4, duration: 0.12, gain: 0.9 }
    ]
  }
}

/** When a score has fallen silent, in seconds. */
export function scoreLength(score: SoundScore): number {
  return Math.max(...score.notes.map((note) => note.start + note.duration)) + score.release
}

/** A score's shape: each step from one note to the next, up, down or the same. */
export function contourOf(score: SoundScore): ('up' | 'down' | 'same')[] {
  return score.notes.slice(1).map((note, index) => (note.freq > score.notes[index].freq ? 'up' : note.freq < score.notes[index].freq ? 'down' : 'same'))
}

/** The sound each kind makes where its notice does not choose one, by its severity: a kind not listed
 * makes none. CRITICAL always makes the critical sound. */
export const KIND_SOUNDS: Readonly<Record<AlertKind, Partial<Record<'watch' | 'high', NoticeSound>>>> = {
  MARKET_EVENT: { watch: 'information', high: 'warning' },
  NEWS_EVENT: { watch: 'information', high: 'warning' },
  TRADE_OPPORTUNITY: { watch: 'opportunity', high: 'opportunity' },
  TRADE_EXECUTED: { watch: 'information', high: 'information' },
  TRADE_BLOCKED: { watch: 'none', high: 'none' },
  POSITION_RISK: { watch: 'warning', high: 'warning' },
  TARGET_REACHED: { watch: 'information', high: 'information' },
  STOP_TRIGGERED: { watch: 'warning', high: 'warning' },
  MODEL_DISAGREEMENT: { watch: 'none', high: 'none' },
  SYSTEM_FAILURE: { watch: 'warning', high: 'warning' },
  CIRCUIT_BREAKER: { watch: 'warning', high: 'warning' },
  RECONCILIATION: { watch: 'warning', high: 'warning' },
  PREDICTION_CHANGED: { watch: 'warning', high: 'warning' },
  MODEL_DEGRADED: { watch: 'none', high: 'none' }
}

/** The sound a notice makes: the one it chose where it was raised, else its kind's at its severity;
 * CRITICAL the critical sound; INFO, and a notice with neither a kind nor a choice below CRITICAL, none. */
export function soundFor(notice: { sound?: NoticeSound | null; kind?: AlertKind | null; severity: AlertSeverity }): SoundName | null {
  if (notice.severity === 'critical') return 'critical'
  if (notice.sound !== undefined && notice.sound !== null) return notice.sound === 'none' ? null : notice.sound
  if (notice.severity === 'info' || notice.kind === undefined || notice.kind === null) return null
  const chosen = KIND_SOUNDS[notice.kind]?.[notice.severity]
  return chosen === undefined || chosen === 'none' ? null : chosen
}

export const SOUND_COOLDOWNS = [0, 30, 60, 300] as const

export interface SoundSettings {
  /** The volume, 0 to 1. */
  volume: number
  /** Kinds that make no sound, CRITICAL apart. */
  mutedKinds: AlertKind[]
  /** Seconds before the same sound plays again, CRITICAL apart. */
  cooldownSec: number
  /** Hours of the computer's day, from and to, in which only CRITICAL sounds; null for none. */
  quietHours: { from: number; to: number } | null
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { volume: 0.7, mutedKinds: [], cooldownSec: 30, quietHours: null }

const hour = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23

export function healSoundSettings(value: unknown): SoundSettings {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Partial<Record<keyof SoundSettings, unknown>>
  const volume = typeof raw.volume === 'number' && Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : DEFAULT_SOUND_SETTINGS.volume
  const muted = Array.isArray(raw.mutedKinds) ? [...new Set(raw.mutedKinds.filter((kind): kind is AlertKind => (ALERT_KINDS as readonly unknown[]).includes(kind)))] : []
  const cooldown = (SOUND_COOLDOWNS as readonly unknown[]).includes(raw.cooldownSec) ? (raw.cooldownSec as number) : DEFAULT_SOUND_SETTINGS.cooldownSec
  const quiet = raw.quietHours as { from?: unknown; to?: unknown } | null | undefined
  return { volume, mutedKinds: muted, cooldownSec: cooldown, quietHours: quiet !== null && typeof quiet === 'object' && hour(quiet.from) && hour(quiet.to) && quiet.from !== quiet.to ? { from: quiet.from, to: quiet.to } : null }
}

/** Whether an hour of the day is inside quiet hours, which may run past midnight. */
export function inQuietHours(quiet: SoundSettings['quietHours'], hourOfDay: number): boolean {
  if (quiet === null) return false
  return quiet.from < quiet.to ? hourOfDay >= quiet.from && hourOfDay < quiet.to : hourOfDay >= quiet.from || hourOfDay < quiet.to
}

/** Whether a sound plays now, and why not. Notices off: nothing. CRITICAL: always, else not with sound
 * off, in quiet hours, for a muted kind, or within the cooldown of the same sound. */
export function shouldPlay(input: {
  sound: SoundName | null
  kind?: AlertKind | null
  alerts: { enabled: boolean; sound: boolean }
  settings: SoundSettings
  hourOfDay: number
  nowMs: number
  lastPlayedMs: Partial<Record<SoundName, number>>
}): { play: boolean; why: string | null } {
  const { sound, settings } = input
  if (sound === null) return { play: false, why: 'It makes no sound: it is seen, not heard.' }
  if (!input.alerts.enabled) return { play: false, why: 'Notices are off.' }
  if (sound === 'critical') return { play: true, why: null }
  if (!input.alerts.sound) return { play: false, why: 'Sound is off.' }
  if (inQuietHours(settings.quietHours, input.hourOfDay)) return { play: false, why: 'Quiet hours.' }
  if (input.kind !== undefined && input.kind !== null && settings.mutedKinds.includes(input.kind)) return { play: false, why: 'Its kind is muted.' }
  const last = input.lastPlayedMs[sound]
  if (last !== undefined && input.nowMs - last < settings.cooldownSec * 1000) return { play: false, why: 'The same sound played moments ago.' }
  return { play: true, why: null }
}

// THE SIMULATOR (§76, §109): the events the document names, each as the notice it raises, so that what
// each sounds like can be heard, and pinned.
export const SIMULATED_EVENTS: readonly { name: string; title: string; kind: AlertKind; severity: Exclude<AlertSeverity, 'info'>; sound?: NoticeSound }[] = [
  { name: 'simulateNewsEvent', title: 'News: a listing on Binance', kind: 'NEWS_EVENT', severity: 'watch' },
  { name: 'simulateMajorNews', title: 'High-impact news: an exploit drains a bridge', kind: 'NEWS_EVENT', severity: 'high' },
  { name: 'simulatePump', title: 'SOL/USDT up 4% in five minutes', kind: 'MARKET_EVENT', severity: 'watch' },
  { name: 'simulateDump', title: 'SOL/USDT down 4% in five minutes', kind: 'MARKET_EVENT', severity: 'high' },
  { name: 'simulateStrongBullish', title: 'STRONG BULLISH: SOL/USDT, next hour', kind: 'TRADE_OPPORTUNITY', severity: 'high', sound: 'opportunity' },
  { name: 'simulateStrongBearish', title: 'STRONG BEARISH: SOL/USDT, next hour', kind: 'TRADE_OPPORTUNITY', severity: 'high', sound: 'warning' },
  { name: 'simulatePredictionFlip', title: 'PREDICTION CHANGED: SOL/USDT BULLISH → BEARISH', kind: 'PREDICTION_CHANGED', severity: 'high' },
  { name: 'simulateTradeReady', title: 'Trade ready: BUY SOL/USDT', kind: 'TRADE_OPPORTUNITY', severity: 'high' },
  { name: 'simulateTradeExecuted', title: 'Paper trade opened: BUY SOL/USDT', kind: 'TRADE_EXECUTED', severity: 'watch' },
  { name: 'simulateStopLoss', title: 'Stop triggered: SOL/USDT', kind: 'STOP_TRIGGERED', severity: 'high' },
  { name: 'simulateTakeProfit', title: 'Target reached: SOL/USDT', kind: 'TARGET_REACHED', severity: 'high' },
  { name: 'simulateCircuitBreaker', title: 'Circuit breaker: the day’s loss limit reached', kind: 'CIRCUIT_BREAKER', severity: 'critical' },
  { name: 'simulateExchangeFailure', title: 'Exchange failure: Binance does not answer', kind: 'SYSTEM_FAILURE', severity: 'critical' }
]

/** The chime for the top prediction changing pair (§72): at most once in this long. */
export const TOP_CHANGE_CHIME_SECONDS = 1800
