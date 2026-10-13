import { SOUND_SCORES, scoreLength, type SoundName, type SoundScore } from '../../shared/sounds'

// THE FOUR SOUNDS, PLAYED (the V6 document, §72-80; V6 Stage 13, 13 October 2026). Each score
// (shared/sounds.ts) is a few oscillator notes, each shaped by its own gain: a rise over the score's
// attack to its gain times the volume, held for the note, then a fall over the release to silence. One
// audio context for the window, made at the first sound; the window may play with nobody pressing
// anything (electron/main.ts sets autoplayPolicy). Sound only: what it means is always shown beside it.

/** The parts of the Web Audio API a score is played through, so a test can hand in its own. */
export interface AudioLike {
  currentTime: number
  destination: unknown
  state?: string
  resume?: () => Promise<void>
  createOscillator: () => {
    type: string
    frequency: { value: number }
    connect: (node: unknown) => unknown
    start: (when: number) => void
    stop: (when: number) => void
  }
  createGain: () => {
    gain: { setValueAtTime: (value: number, when: number) => void; linearRampToValueAtTime: (value: number, when: number) => void; exponentialRampToValueAtTime: (value: number, when: number) => void }
    connect: (node: unknown) => unknown
  }
}

let context: AudioLike | null = null

function audio(): AudioLike | null {
  try {
    if (context === null) context = new AudioContext() as unknown as AudioLike
    if (context.state === 'suspended') void context.resume?.().catch(() => undefined)
    return context
  } catch {
    return null
  }
}

/** Lead time before the first note, so a busy window does not clip it. */
const LEAD_SEC = 0.02

/** Plays a score at a volume of 0 to 1; false where there is no audio to play it on. */
export function playScore(score: SoundScore, volume: number, ctx: AudioLike | null = audio()): boolean {
  if (ctx === null || !(volume > 0)) return false
  const level = Math.min(1, volume)
  const start = ctx.currentTime + LEAD_SEC
  for (const note of score.notes) {
    const oscillator = ctx.createOscillator()
    oscillator.type = score.wave
    oscillator.frequency.value = note.freq
    const gain = ctx.createGain()
    const at = start + note.start
    const peak = note.gain * level
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(peak, at + score.attack)
    gain.gain.setValueAtTime(peak, at + note.duration)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + note.duration + score.release)
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start(at)
    oscillator.stop(at + note.duration + score.release + 0.05)
  }
  return true
}

export function playSound(name: SoundName, volume: number, ctx?: AudioLike | null): boolean {
  return playScore(SOUND_SCORES[name], volume, ctx === undefined ? audio() : ctx)
}

/** How long a sound lasts, in milliseconds: what a simulator waits between two. */
export function soundMs(name: SoundName): number {
  return Math.ceil(scoreLength(SOUND_SCORES[name]) * 1000)
}
