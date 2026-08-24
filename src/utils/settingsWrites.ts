import { createSerialQueue } from './serialQueue'

/** The one queue every read-modify-write against settings goes through.
 *
 * `window.api.settings.set` shallow-merges top-level keys, so any patch carrying a whole array
 * (`{ routines: [...] }`, `{ executors: [...] }`) is a read-modify-write: the array was built from
 * a snapshot, and a write that lands in between is overwritten by it. Re-reading immediately
 * before writing narrows that window but does not close it, because two writers can both be
 * inside it.
 *
 * Shared rather than one queue per writer. Writers touching different keys cannot actually clobber
 * each other -- the main process merges each patch into its live cache -- so a single queue is
 * stricter than strictly necessary. It is also the version that stays correct when someone later
 * adds a writer touching a key another one already owns, which is exactly how these bugs arrive. */
export const settingsWrites = createSerialQueue()
