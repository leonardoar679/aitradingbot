import { describe, expect, it } from 'vitest'
import { HORIZONS } from '../shared/forecast/features'
import { FOLD_MODEL_PATTERN, foldModelName } from '../shared/forecast/modelFile'
import { runsToSweep } from '../shared/forecast/training'

// THE FOLD MODELS (shared/forecast/modelFile.ts; V7.2 Stage 5): each fold's models of a walk forward are saved
// beside its record as fold-<k>-<horizon>.json, k the fold's index as the record's `fold` column counts it, and
// go with the run when it is swept.

describe('the fold models', () => {
  it('are named by the fold index the record counts and the horizon, and read back by the pattern', () => {
    expect(foldModelName(0, 'hour1')).toBe('fold-0-hour1.json')
    expect(foldModelName(3, 'minutes15')).toBe('fold-3-minutes15.json')
    for (const horizon of HORIZONS) {
      const match = FOLD_MODEL_PATTERN.exec(foldModelName(2, horizon))
      expect(match?.[1]).toBe('2')
      expect(match?.[2]).toBe(horizon)
    }
    // A run's own models and the record are not fold models.
    expect(FOLD_MODEL_PATTERN.test('hour1.json')).toBe(false)
    expect(FOLD_MODEL_PATTERN.test('oos-hour1.bin')).toBe(false)
    expect(FOLD_MODEL_PATTERN.test('fold-x-hour1.json')).toBe(false)
  })

  it('go with their run: a run swept takes its folder whole, and a run in use is never swept', () => {
    const runs = ['run-20261014-0030', 'run-20261015-0030', 'run-20261016-0030', 'run-20261017-0030', 'run-20261018-0030']
    expect(runsToSweep(runs, ['run-20261014-0030'])).toEqual(['run-20261015-0030'])
    expect(runsToSweep(runs, [])).toEqual(['run-20261014-0030', 'run-20261015-0030'])
  })
})
