import type { RoutineConfig } from '../../shared/ipc'
import { settingsWrites } from '../utils/settingsWrites'

/** Saves RoutinesPage's local routine list, preserving lastRunAt from storage.
 *
 * settings.set does a shallow top-level merge, so a { routines } patch replaces the WHOLE array
 * -- nothing about individual routines is merged. RoutinesPage loads that array once at mount and
 * never refreshes it, so every later edit writes a mount-time copy back wholesale.
 *
 * lastRunAt is the one field written from outside the page: RoutineScheduler's background timer
 * stamps it whenever a schedule fires. Without this carry-over, toggling an unrelated routine
 * silently reverted a completed run's timestamp to whatever it was when the page opened -- and
 * since the page shows "last run" from that field, a run that really happened stopped being
 * visible anywhere.
 *
 * Queued as well as re-read: re-reading alone still leaves a gap the scheduler can write into
 * between this read and this write. */
export async function persistRoutines(routines: RoutineConfig[]): Promise<void> {
  await settingsWrites(async () => {
    const fresh = await window.api.settings.get()
    const freshLastRunAt = new Map(fresh.routines.map((r) => [r.id, r.lastRunAt]))
    // A routine the page just created is absent from storage, so it keeps whatever lastRunAt it
    // carries locally. Every routine that has actually run is present in storage by construction
    // -- handleRunNow re-reads settings before updating local state -- so today that fallback
    // only ever supplies null. It is written this way so it stays correct if that stops holding.
    const merged = routines.map((r) => ({ ...r, lastRunAt: freshLastRunAt.get(r.id) ?? r.lastRunAt }))
    await window.api.settings.set({ routines: merged })
  })
}
