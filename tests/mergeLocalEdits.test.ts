import { describe, it, expect } from 'vitest'
import { mergeLocalEdits } from '../src/utils/mergeLocalEdits'

type Row = { id: string; name: string; pendingLiveOrderIds?: string[]; liveWatcherId?: string | null }

const X = (over: Partial<Row> = {}): Row => ({ id: 'X', name: 'Live DCA', pendingLiveOrderIds: ['o1'], liveWatcherId: null, ...over })
const Y = (over: Partial<Row> = {}): Row => ({ id: 'Y', name: 'Paper Grid', ...over })

describe('mergeExecutorEdits', () => {
  it('keeps a background patch to an executor the page did not touch', () => {
    // The observed bug: renaming Y wrote the page's stale copy of X back over the scheduler's
    // patch, making a resolved order look pending and forgetting the armed exit watcher.
    const previous = [X(), Y()]
    const fresh = [X({ pendingLiveOrderIds: [], liveWatcherId: 'watcher-7' }), Y()]
    const local = [X(), Y({ name: 'Paper Grid (renamed)' })]

    const merged = mergeLocalEdits({ previous, local, fresh })
    expect(merged.find((e) => e.id === 'X')).toEqual({ id: 'X', name: 'Live DCA', pendingLiveOrderIds: [], liveWatcherId: 'watcher-7' })
    expect(merged.find((e) => e.id === 'Y')?.name).toBe('Paper Grid (renamed)')
  })

  it('lets the page win on the executor it actually edited', () => {
    const previous = [X()]
    const fresh = [X({ liveWatcherId: 'watcher-7' })]
    const local = [X({ name: 'Renamed' })]

    // The page changed X, so the page's X is what is being saved -- background fields included.
    expect(mergeLocalEdits({ previous, local, fresh })).toEqual([X({ name: 'Renamed' })])
  })

  it('keeps an executor the page just created', () => {
    const previous = [X()]
    const local = [X(), Y()]
    const merged = mergeLocalEdits({ previous, local, fresh: [X()] })
    expect(merged.map((e) => e.id)).toEqual(['X', 'Y'])
  })

  it('honours an executor the page deleted', () => {
    const previous = [X(), Y()]
    const merged = mergeLocalEdits({ previous, local: [X()], fresh: [X(), Y()] })
    expect(merged.map((e) => e.id)).toEqual(['X'])
  })

  it('keeps an executor created elsewhere since the page last read', () => {
    const previous = [X()]
    const merged = mergeLocalEdits({ previous, local: [X({ name: 'Renamed' })], fresh: [X(), Y()] })
    expect(merged.map((e) => e.id).sort()).toEqual(['X', 'Y'])
  })

  it('drops an executor deleted elsewhere that the page did not touch', () => {
    const previous = [X(), Y()]
    const merged = mergeLocalEdits({ previous, local: [X(), Y()], fresh: [X()] })
    expect(merged.map((e) => e.id)).toEqual(['X'])
  })

  it('preserves the page ordering', () => {
    const previous = [X(), Y()]
    const merged = mergeLocalEdits({ previous, local: [Y(), X()], fresh: [X(), Y()] })
    expect(merged.map((e) => e.id)).toEqual(['Y', 'X'])
  })

  it('is a no-op when nothing anywhere has changed', () => {
    const rows = [X(), Y()]
    expect(mergeLocalEdits({ previous: rows, local: rows, fresh: rows })).toEqual(rows)
  })
})
