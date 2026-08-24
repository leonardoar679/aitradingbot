import { beforeEach, describe, expect, it } from 'vitest'
import type { RoutineConfig } from '../shared/ipc'
import { persistRoutines } from '../src/routines/persistRoutines'
import { settingsWrites } from '../src/utils/settingsWrites'

// RoutinesPage loads settings.routines once at mount and never refreshes it. settings.set does a
// shallow top-level merge, so writing { routines } replaces the whole array -- which means any
// later edit on the page writes a mount-time copy back over whatever the background scheduler
// has stamped since. lastRunAt is the field that gets lost, and "last run ..." on the card is
// the only place a completed scheduled run is ever visible.

const routine = (id: string, name: string, lastRunAt: number | null): RoutineConfig => ({
  id,
  name,
  exchange: 'binance',
  symbol: 'BTCUSDT',
  interval: '1h',
  strategyId: 'sma-cross',
  scheduleId: 'daily',
  enabled: true,
  lastRunAt
} as RoutineConfig)

let stored: { routines: RoutineConfig[] }

// Every read yields to the microtask queue before answering, so an unserialised writer really
// does interleave here rather than only in principle.
function installWindowApi(): void {
  stored = { routines: [] }
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      settings: {
        get: async () => {
          await Promise.resolve()
          return { routines: stored.routines.map((r) => ({ ...r })) }
        },
        set: async (patch: { routines: RoutineConfig[] }) => {
          await Promise.resolve()
          stored = { ...stored, ...patch }
        }
      }
    }
  }
}

beforeEach(installWindowApi)

describe('persistRoutines', () => {
  it('keeps a lastRunAt the scheduler stamped after the page loaded', async () => {
    // Storage has moved on: the scheduler ran routine A at 500.
    stored.routines = [routine('a', 'Morning', 500), routine('b', 'Evening', null)]
    // The page still holds its mount-time copy, where A had never run, and the user has just
    // renamed B -- an edit that has nothing to do with A.
    await persistRoutines([routine('a', 'Morning', null), routine('b', 'Evening renamed', null)])

    expect(stored.routines.find((r) => r.id === 'a')?.lastRunAt).toBe(500)
    expect(stored.routines.find((r) => r.id === 'b')?.name).toBe('Evening renamed')
  })

  it('saves the page edits it is actually there to save', async () => {
    stored.routines = [routine('a', 'Morning', 500)]
    await persistRoutines([routine('a', 'Morning', null), routine('b', 'New one', null)])

    expect(stored.routines.map((r) => r.name)).toEqual(['Morning', 'New one'])
  })

  it('leaves a routine created locally with its own null lastRunAt', async () => {
    stored.routines = []
    await persistRoutines([routine('new', 'Fresh', null)])

    expect(stored.routines).toHaveLength(1)
    expect(stored.routines[0].lastRunAt).toBeNull()
  })

  it('still deletes a routine the page removed', async () => {
    stored.routines = [routine('a', 'Morning', 500), routine('b', 'Evening', 700)]
    await persistRoutines([routine('a', 'Morning', null)])

    expect(stored.routines.map((r) => r.id)).toEqual(['a'])
    expect(stored.routines[0].lastRunAt).toBe(500)
  })

  it('does not lose a run the scheduler stamps mid-save', async () => {
    stored.routines = [routine('a', 'Morning', null), routine('b', 'Evening', null)]

    // Both writers go through the shared settings queue, exactly as they do in the app: the page
    // saving a rename, and RoutineScheduler stamping a run that finished at the same moment.
    // Re-reading is not enough on its own -- without the queue one lands inside the other's
    // read-modify-write and is overwritten.
    await Promise.all([
      persistRoutines([routine('a', 'Morning', null), routine('b', 'Evening renamed', null)]),
      settingsWrites(async () => {
        const fresh = await window.api.settings.get()
        const next = fresh.routines.map((r) => (r.id === 'a' ? { ...r, lastRunAt: 900 } : r))
        await window.api.settings.set({ routines: next })
      })
    ])

    expect(stored.routines.find((r) => r.id === 'a')?.lastRunAt).toBe(900)
    expect(stored.routines.find((r) => r.id === 'b')?.name).toBe('Evening renamed')
  })
})

// Not reachable from today's call sites -- handleRunNow re-reads settings before updating local
// state, so anything with a lastRunAt is already in storage. Pinned because persistRoutines
// promises the fallback in its own comment, and a future caller could rely on it.
describe('persistRoutines lastRunAt fallback', () => {
  it('keeps a local lastRunAt when storage has no row to carry over from', async () => {
    stored.routines = []
    await persistRoutines([routine('a', 'Morning', 400)])

    expect(stored.routines[0].lastRunAt).toBe(400)
  })
})
