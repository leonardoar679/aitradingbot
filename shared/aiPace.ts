// HOW FAST ONE MODEL IS ASKED.
//
// A benchmark asks four questions at once, and a fast model answers each in two seconds: left
// alone, that is a hundred and twenty calls a minute to one model, and providers answer that with
// a 429. On 5 October 2026 OpenRouter rate-limited Mistral Small after four answers of a hundred,
// twice. So no more than so many calls a minute start to any one model, whoever asks -- a
// benchmark, the watch, a bot, a click -- held in the main process where every call is made.
//
// A call that would go over waits for its place; nothing is refused. The setting is one of a few
// round numbers, changed under Settings › AI.

export const AI_CALLS_PER_MINUTE_CHOICES = [10, 20, 30, 60] as const
export const DEFAULT_AI_CALLS_PER_MINUTE = 30

const WINDOW_MS = 60_000

export function isCallsPerMinute(value: unknown): value is number {
  return (AI_CALLS_PER_MINUTE_CHOICES as readonly unknown[]).includes(value)
}

/** How long one more call has to wait so that no more than `perMinute` start in any sixty
 * seconds, given when the model's recent calls started (milliseconds). Zero when it can start now. */
export function paceDelayMs(starts: number[], nowMs: number, perMinute: number): number {
  const recent = starts.filter((at) => nowMs - at < WINDOW_MS && at <= nowMs).sort((a, b) => a - b)
  if (recent.length < perMinute) return 0
  // The call takes the place of the start that leaves the window first among those it must wait
  // out: with `perMinute` already in the window, the oldest.
  return recent[recent.length - perMinute] + WINDOW_MS - nowMs
}

/** The least time `calls` calls to one model take at that pace, in milliseconds: a minute for each
 * full window after the first. Whatever else a run waits for comes on top of this. */
export function pacedMinimumMs(calls: number, perMinute: number): number {
  if (!(calls > 0) || !(perMinute > 0)) return 0
  return Math.floor((calls - 1) / perMinute) * WINDOW_MS
}
