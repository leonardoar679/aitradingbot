/** Runs async tasks one at a time, in the order they were handed over.
 *
 * Exists for read-modify-write sequences against settings. `window.api.settings.set` is a shallow
 * top-level merge, so a patch like `{ routines: [...] }` replaces the whole array -- which makes
 * every such write a read-modify-write, and two of them interleaved lose one of the two changes
 * entirely. That is not a rare race: two routines on the same schedule preset get their timers
 * from a single effect run, so they fire on the same tick, every tick.
 *
 * Queueing rather than skipping (unlike singleFlight, which drops overlapping work): both writers
 * have a real change to apply, so neither may be dropped -- they just have to take turns. */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  // Deliberately only ever a fulfilled promise. A failing task must not stop the ones queued
  // behind it, and a rejected `tail` left with no follow-up task would also surface as an
  // unhandled rejection. The rejection is still delivered to whoever awaited that task.
  let tail: Promise<unknown> = Promise.resolve()

  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
