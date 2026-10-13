import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SOUND_SETTINGS,
  KIND_SOUNDS,
  SIMULATED_EVENTS,
  SOUNDS,
  SOUND_SCORES,
  TOP_CHANGE_CHIME_SECONDS,
  contourOf,
  healSoundSettings,
  inQuietHours,
  scoreLength,
  shouldPlay,
  soundFor,
  type SoundName
} from '../shared/sounds'
import { ALERT_KINDS } from '../shared/alerts'
import { playScore, type AudioLike } from '../src/sound/player'
import { hearNotice, resetNoticeSounds, setSoundPrefs, soundOfRecord, topPredictionChime } from '../src/sound/hearing'

// SOUNDS BY MEANING (shared/sounds.ts, src/sound/; the V6 document, §72-80 and §109-110): four scores told
// apart by their shape, short and gentle; which sound each notice makes, the simulator's events among
// them; the controls -- sound off, quiet hours, a kind muted, the cooldown -- with CRITICAL heard
// through all but notices off; each score played on the audio as written; and the chime for a new top
// prediction at most once in half an hour.

describe('the four scores', () => {
  it('are short, gentle and never louder than the volume', () => {
    for (const name of SOUNDS) {
      const score = SOUND_SCORES[name]
      expect(score.name).toBe(name)
      expect(scoreLength(score), name).toBeLessThanOrEqual(1.5)
      expect(score.attack, name).toBeGreaterThanOrEqual(0.005)
      for (const note of score.notes) {
        expect(note.freq, name).toBeLessThanOrEqual(2500)
        expect(note.freq, name).toBeGreaterThanOrEqual(200)
        expect(note.gain, name).toBeGreaterThan(0)
        expect(note.gain, name).toBeLessThanOrEqual(1)
      }
    }
  })

  it('are told apart by their shape: rising a sixth, three rising, two falling, a pulse of three', () => {
    expect(SOUNDS.map((name) => contourOf(SOUND_SCORES[name]).join(' '))).toEqual(['up', 'up up', 'down', 'same same'])
    expect(new Set(SOUNDS.map((name) => `${contourOf(SOUND_SCORES[name]).join(' ')}:${SOUND_SCORES[name].notes.length}`)).size).toBe(4)
    // The chime rises a sixth; the warning falls a fifth.
    expect(SOUND_SCORES.information.notes[1].freq / SOUND_SCORES.information.notes[0].freq).toBeCloseTo(1.68, 2)
    expect(SOUND_SCORES.warning.notes[0].freq / SOUND_SCORES.warning.notes[1].freq).toBeCloseTo(1.5, 2)
  })
})

describe('which sound a notice makes', () => {
  it('is the one it chose where it was raised, else its kind’s, CRITICAL always the critical sound', () => {
    expect(soundFor({ severity: 'critical', kind: 'MARKET_EVENT', sound: 'information' })).toBe('critical')
    expect(soundFor({ severity: 'high', kind: 'TRADE_OPPORTUNITY', sound: 'warning' })).toBe('warning')
    expect(soundFor({ severity: 'high', kind: 'MARKET_EVENT', sound: 'none' })).toBeNull()
    expect(soundFor({ severity: 'watch', kind: 'MARKET_EVENT' })).toBe('information')
    expect(soundFor({ severity: 'high', kind: 'MARKET_EVENT' })).toBe('warning')
    expect(soundFor({ severity: 'high', kind: null })).toBeNull()
    expect(soundFor({ severity: 'info', kind: 'NEWS_EVENT' })).toBeNull()
    // Every kind has a sound for both its levels, or none, by the table.
    for (const kind of ALERT_KINDS) expect(Object.keys(KIND_SOUNDS[kind]).sort(), kind).toEqual(['high', 'watch'])
  })

  it('is seen, not heard, for a trade refused, a disagreement and a degraded model (§72)', () => {
    for (const kind of ['TRADE_BLOCKED', 'MODEL_DISAGREEMENT', 'MODEL_DEGRADED'] as const) {
      expect(soundFor({ severity: 'high', kind })).toBeNull()
      expect(soundFor({ severity: 'watch', kind })).toBeNull()
    }
  })

  it('sounds each simulated event by its meaning (§76, §109)', () => {
    expect(Object.fromEntries(SIMULATED_EVENTS.map((event) => [event.name, soundFor(event)]))).toEqual({
      simulateNewsEvent: 'information',
      simulateMajorNews: 'warning',
      simulatePump: 'information',
      simulateDump: 'warning',
      simulateStrongBullish: 'opportunity',
      simulateStrongBearish: 'warning',
      simulatePredictionFlip: 'warning',
      simulateTradeReady: 'opportunity',
      simulateTradeExecuted: 'information',
      simulateStopLoss: 'warning',
      simulateTakeProfit: 'information',
      simulateCircuitBreaker: 'critical',
      simulateExchangeFailure: 'critical'
    })
  })
})

describe('the controls (§77-78)', () => {
  const at = (input: Partial<Parameters<typeof shouldPlay>[0]> = {}) =>
    shouldPlay({ sound: 'information', kind: 'MARKET_EVENT', alerts: { enabled: true, sound: true }, settings: DEFAULT_SOUND_SETTINGS, hourOfDay: 12, nowMs: 1_000_000, lastPlayedMs: {}, ...input })

  it('play a sound only with notices and sound on, outside quiet hours, for a kind not muted, past the cooldown', () => {
    expect(at()).toEqual({ play: true, why: null })
    expect(at({ alerts: { enabled: false, sound: true } }).play).toBe(false)
    expect(at({ alerts: { enabled: true, sound: false } }).why).toBe('Sound is off.')
    expect(at({ settings: { ...DEFAULT_SOUND_SETTINGS, quietHours: { from: 22, to: 7 } }, hourOfDay: 23 }).why).toBe('Quiet hours.')
    expect(at({ settings: { ...DEFAULT_SOUND_SETTINGS, quietHours: { from: 22, to: 7 } }, hourOfDay: 7 }).play).toBe(true)
    expect(at({ settings: { ...DEFAULT_SOUND_SETTINGS, mutedKinds: ['MARKET_EVENT'] } }).why).toBe('Its kind is muted.')
    expect(at({ lastPlayedMs: { information: 1_000_000 - 29_000 } }).why).toBe('The same sound played moments ago.')
    expect(at({ lastPlayedMs: { information: 1_000_000 - 30_000 } }).play).toBe(true)
    // Another sound is not held back by the cooldown of one.
    expect(at({ lastPlayedMs: { warning: 1_000_000 - 1000 } }).play).toBe(true)
    expect(at({ sound: null }).why).toBe('It makes no sound: it is seen, not heard.')
  })

  it('hear CRITICAL with sound off, in quiet hours, for a muted kind and in the cooldown, and not with notices off', () => {
    const critical = { sound: 'critical' as const, settings: { ...DEFAULT_SOUND_SETTINGS, quietHours: { from: 0, to: 23 }, mutedKinds: [...ALERT_KINDS] }, lastPlayedMs: { critical: 1_000_000 }, alerts: { enabled: true, sound: false } }
    expect(at(critical)).toEqual({ play: true, why: null })
    expect(at({ ...critical, alerts: { enabled: false, sound: true } }).play).toBe(false)
  })

  it('read quiet hours across midnight, and are healed to their choices', () => {
    expect([21, 22, 23, 0, 6, 7, 12].map((hour) => inQuietHours({ from: 22, to: 7 }, hour))).toEqual([false, true, true, true, true, false, false])
    expect([8, 9, 16, 17].map((hour) => inQuietHours({ from: 9, to: 17 }, hour))).toEqual([false, true, true, false])
    expect(inQuietHours(null, 3)).toBe(false)
    expect(healSoundSettings(undefined)).toEqual({ volume: 0.7, mutedKinds: [], cooldownSec: 30, quietHours: null })
    expect(healSoundSettings({ volume: 3, mutedKinds: ['STOP_TRIGGERED', 'NOPE', 'STOP_TRIGGERED'], cooldownSec: 45, quietHours: { from: 5, to: 5 } })).toEqual({ volume: 1, mutedKinds: ['STOP_TRIGGERED'], cooldownSec: 30, quietHours: null })
    expect(healSoundSettings({ volume: 0.4, cooldownSec: 300, quietHours: { from: 23, to: 6 } })).toEqual({ volume: 0.4, mutedKinds: [], cooldownSec: 300, quietHours: { from: 23, to: 6 } })
  })
})

/** An audio context that writes down what it is asked to play. */
function fakeAudio(): AudioLike & { notes: { type: string; freq: number; start: number; stop: number; ramps: [string, number, number][] }[] } {
  const notes: { type: string; freq: number; start: number; stop: number; ramps: [string, number, number][] }[] = []
  return {
    currentTime: 10,
    destination: {},
    notes,
    createOscillator() {
      const note = { type: '', freq: 0, start: 0, stop: 0, ramps: [] as [string, number, number][] }
      notes.push(note)
      return {
        get type() {
          return note.type
        },
        set type(value: string) {
          note.type = value
        },
        frequency: {
          get value() {
            return note.freq
          },
          set value(value: number) {
            note.freq = value
          }
        },
        connect: (node: unknown) => node,
        start: (when: number) => void (note.start = when),
        stop: (when: number) => void (note.stop = when)
      }
    },
    createGain() {
      const note = notes[notes.length - 1]
      return {
        gain: {
          setValueAtTime: (value: number, when: number) => void note.ramps.push(['set', value, when]),
          linearRampToValueAtTime: (value: number, when: number) => void note.ramps.push(['linear', value, when]),
          exponentialRampToValueAtTime: (value: number, when: number) => void note.ramps.push(['exp', value, when])
        },
        connect: (node: unknown) => node
      }
    }
  }
}

describe('the player', () => {
  it('plays each note of a score at its time, its wave and its gain times the volume, rising over the attack', () => {
    const ctx = fakeAudio()
    expect(playScore(SOUND_SCORES.opportunity, 0.5, ctx)).toBe(true)
    expect(ctx.notes.map((note) => [note.type, note.freq])).toEqual(SOUND_SCORES.opportunity.notes.map((note) => ['triangle', note.freq]))
    const [first, second] = ctx.notes
    expect(first.start).toBeCloseTo(10.02, 9)
    expect(second.start).toBeCloseTo(10.02 + 0.12, 9)
    expect(first.ramps[0]).toEqual(['set', 0, first.start])
    expect(first.ramps[1][0]).toBe('linear')
    expect(first.ramps[1][1]).toBeCloseTo(0.55 * 0.5, 12)
    expect(first.ramps[1][2]).toBeCloseTo(first.start + SOUND_SCORES.opportunity.attack, 12)
    // Never above the volume, and silent by its stop.
    for (const note of ctx.notes) {
      expect(Math.max(...note.ramps.map((ramp) => ramp[1]))).toBeLessThanOrEqual(0.5)
      expect(note.stop).toBeGreaterThan(note.ramps[note.ramps.length - 1][2])
    }
    expect(playScore(SOUND_SCORES.information, 0, fakeAudio())).toBe(false)
    expect(playScore(SOUND_SCORES.information, 0.7, null)).toBe(false)
  })
})

describe('a told notice, heard', () => {
  beforeEach(() => resetNoticeSounds())

  it('plays the sound on its record, else its kind’s, and remembers it for the cooldown', () => {
    const played: [SoundName, number][] = []
    const play = (name: SoundName, volume: number): boolean => void played.push([name, volume]) ?? true
    const now = new Date(2026, 9, 13, 12, 0, 0)
    expect(soundOfRecord({ sound: 'opportunity', kind: 'MARKET_EVENT', severity: 'watch' })).toBe('opportunity')
    expect(soundOfRecord({ sound: 'none', kind: 'MARKET_EVENT', severity: 'watch' })).toBeNull()
    expect(soundOfRecord({ sound: 'none', kind: 'MARKET_EVENT', severity: 'critical' })).toBe('critical')
    expect(soundOfRecord({ kind: 'STOP_TRIGGERED', severity: 'high' })).toBe('warning')
    expect(hearNotice({ sound: 'information', kind: 'MARKET_EVENT', severity: 'watch' }, now, play)).toEqual({ played: 'information', why: null })
    expect(hearNotice({ sound: 'information', kind: 'NEWS_EVENT', severity: 'watch' }, new Date(now.getTime() + 5000), play).played).toBeNull()
    expect(hearNotice({ sound: 'warning', kind: 'STOP_TRIGGERED', severity: 'high' }, new Date(now.getTime() + 5000), play).played).toBe('warning')
    expect(played).toEqual([
      ['information', 0.7],
      ['warning', 0.7]
    ])
    setSoundPrefs({ alerts: { enabled: true, sound: false }, sounds: { ...DEFAULT_SOUND_SETTINGS, volume: 0.3 } })
    expect(hearNotice({ kind: 'STOP_TRIGGERED', severity: 'high' }, new Date(now.getTime() + 60_000), play).why).toBe('Sound is off.')
    expect(hearNotice({ severity: 'critical' }, new Date(now.getTime() + 60_000), play).played).toBe('critical')
    expect(played.at(-1)).toEqual(['critical', 0.3])
  })

  it('chimes for the top prediction changing pair at most once in half an hour, never for the first one read', () => {
    expect(topPredictionChime('SOLUSDT', 1000)).toBe(false)
    expect(topPredictionChime('SOLUSDT', 1300)).toBe(false)
    expect(topPredictionChime('ETHUSDT', 1600)).toBe(true)
    expect(topPredictionChime('SOLUSDT', 1600 + TOP_CHANGE_CHIME_SECONDS - 1)).toBe(false)
    expect(topPredictionChime('BTCUSDT', 1600 + TOP_CHANGE_CHIME_SECONDS)).toBe(true)
    expect(topPredictionChime(null, 99_999)).toBe(false)
  })
})
