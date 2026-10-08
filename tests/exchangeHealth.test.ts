import { describe, expect, it } from 'vitest'
import { HEALTH_LINES, describeHealth, describePause, emptyHealthState, healthVerdict, type HealthState } from '../shared/exchangeHealth'

// EXCHANGE HEALTH (shared/exchangeHealth.ts; the V4 document, §12 and §92-93): the rule that pauses
// a NEW real position when the exchange cannot be trusted for one, and never an exit. Each line is
// pinned at its edge.

const healthy = (over: Partial<HealthState> = {}): HealthState => ({
  ...emptyHealthState(),
  measuredAt: 1_791_500_000,
  host: 'data-api.binance.vision',
  restLatencyMs: 180,
  clockSkewMs: 120,
  streamOpen: true,
  dataAgeS: 0.4,
  keyOk: true,
  ...over
})

describe('the verdict', () => {
  it('is not degraded before anything was measured, nor on a healthy exchange', () => {
    expect(healthVerdict(emptyHealthState())).toEqual({ degraded: false, reasons: [] })
    expect(healthVerdict(healthy())).toEqual({ degraded: false, reasons: [] })
    expect(describePause(healthVerdict(healthy()))).toBeNull()
  })

  it('pauses when the data is stale AND REST has failed three reads running, and not on either alone', () => {
    expect(healthVerdict(healthy({ dataAgeS: HEALTH_LINES.staleDataSeconds, restFailures: 3 })).reasons).toEqual(['market data stale 60 s and REST has failed 3 reads running'])
    expect(healthVerdict(healthy({ dataAgeS: HEALTH_LINES.staleDataSeconds - 0.1, restFailures: 3 })).degraded).toBe(false)
    expect(healthVerdict(healthy({ dataAgeS: 600, restFailures: 2 })).degraded).toBe(false)
    expect(healthVerdict(healthy({ streamOpen: false, restFailures: 3 })).degraded).toBe(true)
    expect(healthVerdict(healthy({ dataAgeS: null, restFailures: 3 })).reasons).toEqual(['no market data: the stream has delivered nothing and REST has failed 3 reads running'])
    expect(healthVerdict(healthy({ dataAgeS: null, restFailures: 0 })).degraded).toBe(false)
  })

  it('pauses on a clock over five seconds off, either way', () => {
    expect(healthVerdict(healthy({ clockSkewMs: HEALTH_LINES.clockSkewMs })).degraded).toBe(false)
    expect(healthVerdict(healthy({ clockSkewMs: HEALTH_LINES.clockSkewMs + 1 })).reasons).toEqual(["the clock is 5 s behind Binance's"])
    expect(healthVerdict(healthy({ clockSkewMs: -7_400 })).reasons).toEqual(["the clock is 7.4 s ahead of Binance's"])
    expect(healthVerdict(healthy({ clockSkewMs: null })).degraded).toBe(false)
  })

  it('pauses on REST slow three reads running, and on a key whose last test failed', () => {
    expect(healthVerdict(healthy({ slowReads: HEALTH_LINES.slowReadsToPause - 1 })).degraded).toBe(false)
    expect(healthVerdict(healthy({ slowReads: HEALTH_LINES.slowReadsToPause })).reasons).toEqual(['REST has taken over 5 s 3 reads running'])
    expect(healthVerdict(healthy({ keyOk: false })).reasons).toEqual(["the Binance key's last test failed"])
    expect(healthVerdict(healthy({ keyOk: null })).degraded).toBe(false)
  })

  it('says every reason at once, and that exits are not paused', () => {
    const verdict = healthVerdict(healthy({ clockSkewMs: 9_000, keyOk: false }))
    expect(verdict.reasons).toHaveLength(2)
    expect(describePause(verdict)).toBe("Live trading is paused: the clock is 9 s behind Binance's; the Binance key's last test failed. Exits are not paused by this.")
  })
})

describe('the figures in words', () => {
  it('says each as measured, and what was not measured', () => {
    expect(describeHealth(emptyHealthState())).toEqual({ latency: 'not measured yet', clock: 'not measured yet', stream: 'closed', key: 'no key stored' })
    expect(describeHealth(healthy())).toEqual({ latency: '180 ms', clock: "+120 ms against Binance's", stream: 'open, last frame 0.4 s ago', key: 'last test passed' })
    expect(describeHealth(healthy({ restLatencyMs: null, restFailures: 2, keyOk: false, streamOpen: true, dataAgeS: null }))).toEqual({
      latency: 'the last 2 reads failed',
      clock: "+120 ms against Binance's",
      stream: 'open, no frame yet',
      key: 'last test failed'
    })
    expect(describeHealth(healthy({ restLatencyMs: 6_200, slowReads: 2, clockSkewMs: -40 })).latency).toBe('6200 ms (2 slow in a row)')
    expect(describeHealth(healthy({ clockSkewMs: -40 })).clock).toBe("-40 ms against Binance's")
  })
})
