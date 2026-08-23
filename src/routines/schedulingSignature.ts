import type { RoutineConfig } from '../../shared/ipc'

/** Identifies everything about a routine list that affects how it should be scheduled -- which is
 * everything except `lastRunAt`.
 *
 * RoutineScheduler polls settings to notice config edits, and rebuilds its intervals whenever the
 * list it holds changes. It compared the whole serialized list, and `lastRunAt` is part of that:
 * so every completed run rewrote settings, the next poll saw a difference, and the effect tore
 * down and recreated EVERY routine's interval from zero.
 *
 * A routine's timer therefore never accumulated more than the shortest routine's period plus one
 * poll, and anything slower than that never fired at all. Simulated over six virtual hours with
 * routines at 60s / 15min / 1h, polling every 10s:
 *
 *   every 60s     360 expected, 308 actual
 *   every 15min    24 expected,   0 actual
 *   every hour      6 expected,   0 actual
 *
 * Excluding lastRunAt means a run no longer counts as a config change, so the timers survive it.
 * Any other field still rebuilds them, including fields added later. */
export function schedulingSignature(routines: RoutineConfig[]): string {
  return JSON.stringify(routines.map(({ lastRunAt: _lastRunAt, ...scheduling }) => scheduling))
}
