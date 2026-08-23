import { describe, it, expect } from 'vitest'
import { schedulingSignature } from '../src/routines/schedulingSignature'
import type { RoutineConfig } from '../shared/ipc'

function routine(over: Partial<RoutineConfig> = {}): RoutineConfig {
  return {
    id: 'r1',
    name: 'Morning check',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: '4h',
    strategyId: 'ema-cross-atr-stop',
    scheduleSec: 3600,
    enabled: true,
    lastRunAt: null,
    ...over
  } as RoutineConfig
}

describe('schedulingSignature', () => {
  // The whole point: a completed run must not look like a config change, or the scheduler
  // rebuilds every interval and slower routines never get to elapse.
  it('is unchanged when only lastRunAt moves', () => {
    const before = schedulingSignature([routine({ lastRunAt: null })])
    const after = schedulingSignature([routine({ lastRunAt: 1_700_000_000 })])
    expect(after).toBe(before)
  })

  it('is unchanged across repeated runs of several routines', () => {
    const list = [routine({ id: 'a', scheduleSec: 60 }), routine({ id: 'b', scheduleSec: 3600 })]
    const first = schedulingSignature(list)
    const afterRuns = schedulingSignature([
      routine({ id: 'a', scheduleSec: 60, lastRunAt: 111 }),
      routine({ id: 'b', scheduleSec: 3600, lastRunAt: 222 })
    ])
    expect(afterRuns).toBe(first)
  })

  it('changes when a routine is enabled or disabled', () => {
    expect(schedulingSignature([routine({ enabled: false })])).not.toBe(schedulingSignature([routine({ enabled: true })]))
  })

  it('changes when the schedule interval changes', () => {
    expect(schedulingSignature([routine({ scheduleSec: 60 })])).not.toBe(schedulingSignature([routine({ scheduleSec: 120 })]))
  })

  it('changes when a routine is added or removed', () => {
    expect(schedulingSignature([routine()])).not.toBe(schedulingSignature([]))
    expect(schedulingSignature([routine(), routine({ id: 'r2' })])).not.toBe(schedulingSignature([routine()]))
  })

  it('changes when what the routine actually runs changes', () => {
    const base = schedulingSignature([routine()])
    expect(schedulingSignature([routine({ symbol: 'ETHUSDT' })])).not.toBe(base)
    expect(schedulingSignature([routine({ interval: '1h' })])).not.toBe(base)
    expect(schedulingSignature([routine({ strategyId: 'rsi-reversion' })])).not.toBe(base)
    expect(schedulingSignature([routine({ exchange: 'coinbase' })])).not.toBe(base)
  })

  it('is empty-list stable', () => {
    expect(schedulingSignature([])).toBe(schedulingSignature([]))
  })

  // A field added to RoutineConfig later should rebuild the timers by default, rather than being
  // silently ignored the way lastRunAt now is on purpose.
  it('reacts to a field it has never seen before', () => {
    const withExtra = { ...routine(), somethingNew: 5 } as unknown as RoutineConfig
    expect(schedulingSignature([withExtra])).not.toBe(schedulingSignature([routine()]))
  })
})
