import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The exchange health monitor (electron/services/exchangeHealthService.ts), driven with the data
// host, the live socket and the key faked: one measurement at a time, what it keeps of a read that
// answered, one that was slow and one that failed, and the verdict the live order gate reads.

const rig = vi.hoisted(() => ({
  live: { open: true, lastMessageAt: null as number | null },
  key: { configured: true, lastTestOk: true as boolean | null },
  server: { skewMs: 50, delayMs: 0, fail: false }
}))

/** What the main process told: live entries paused, and resumed (the V4 document, §48). */
const told = vi.hoisted(() => [] as { title: string; body: string; extra: { kind: string; thread?: string } }[])
vi.mock('../electron/services/noticeService', () => ({
  tell: (notice: { title: string; body: string; extra: { kind: string; thread?: string } }) => void told.push(notice),
  tellNotice: async () => true
}))
vi.mock('../electron/services/liveMarketService', () => ({ getLiveState: () => ({ connection: rig.live }) }))
vi.mock('../electron/services/credentialsService', () => ({
  listCredentialStatus: async () => [{ exchange: 'binance', configured: rig.key.configured, lastTestOk: rig.key.lastTestOk }]
}))
vi.mock('../electron/services/exchanges/binance', () => ({
  resolveEndpoint: async () => ({ name: 'data-api.binance.vision', restRoot: 'https://data-api.binance.vision/api/v3', wsBase: 'wss://data-stream.binance.vision/ws' })
}))

import { getHealthState, liveHealth, liveHealthReasons, onHealthUpdate, probeOnce, resetExchangeHealth } from '../electron/services/exchangeHealthService'

const NOW_MS = Date.parse('2026-10-08T12:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_MS)
  resetExchangeHealth()
  rig.live.open = true
  rig.live.lastMessageAt = NOW_MS - 300
  rig.key.configured = true
  rig.key.lastTestOk = true
  rig.server.skewMs = 50
  rig.server.delayMs = 0
  rig.server.fail = false
  vi.stubGlobal('fetch', async (url: string) => {
    if (rig.server.fail) throw new TypeError('fetch failed')
    // The round trip takes `delayMs` of the faked clock.
    vi.setSystemTime(Date.now() + rig.server.delayMs)
    const serverTime = Date.now() - rig.server.delayMs / 2 + rig.server.skewMs
    return { ok: true, status: 200, json: async () => ({ serverTime }), url }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('one measurement', () => {
  it('keeps the round trip, the clock against Binance\'s, the host, the key, and reads the stream live', async () => {
    const heard: unknown[] = []
    onHealthUpdate((state) => heard.push(state))
    rig.server.delayMs = 200
    const state = await probeOnce()
    expect(state).toMatchObject({ host: 'data-api.binance.vision', restLatencyMs: 200, restFailures: 0, slowReads: 0, clockSkewMs: 50, keyOk: true, streamOpen: true })
    expect(state.measuredAt).toBe(Math.floor(NOW_MS / 1000))
    expect(heard).toHaveLength(1)
    expect(liveHealth()).toEqual({ degraded: false, reasons: [] })
    // The stream's age is read as it stands now, not as it was measured.
    rig.live.lastMessageAt = Date.now() - 90_000
    expect(getHealthState().dataAgeS).toBe(90)
  })

  it('counts reads that failed and reads that were slow, each in a row, and forgets them on a good one', async () => {
    rig.server.fail = true
    await probeOnce()
    await probeOnce()
    expect(getHealthState()).toMatchObject({ restFailures: 2, restLatencyMs: null })
    expect(liveHealthReasons()).toEqual([])
    rig.live.lastMessageAt = Date.now() - 120_000
    await probeOnce()
    expect(liveHealthReasons()).toEqual(['market data stale 120 s and REST has failed 3 reads running'])
    rig.server.fail = false
    rig.server.delayMs = 6_000
    await probeOnce()
    expect(getHealthState()).toMatchObject({ restFailures: 0, slowReads: 1, restLatencyMs: 6_000 })
    await probeOnce()
    await probeOnce()
    expect(liveHealthReasons()).toEqual(['REST has taken over 5 s 3 reads running'])
    rig.server.delayMs = 100
    await probeOnce()
    expect(getHealthState()).toMatchObject({ restFailures: 0, slowReads: 0 })
    expect(liveHealthReasons()).toEqual([])
  })

  it('reads the key: none stored is no reason, a failed test is', async () => {
    rig.key.configured = false
    expect((await probeOnce()).keyOk).toBeNull()
    rig.key.configured = true
    rig.key.lastTestOk = false
    expect((await probeOnce()).keyOk).toBe(false)
    expect(liveHealthReasons()).toEqual(["the Binance key's last test failed"])
    rig.key.lastTestOk = null
    expect((await probeOnce()).keyOk).toBe(true)
  })

  it('pauses on a clock off Binance\'s by over five seconds', async () => {
    rig.server.skewMs = 5_400
    await probeOnce()
    expect(liveHealthReasons()).toEqual(["the clock is 5.4 s behind Binance's"])
  })
})

describe('the pause, told', () => {
  it('is told when live entries pause and when they resume, once each, not on every measurement', async () => {
    told.length = 0
    rig.server.skewMs = 9_000
    await probeOnce()
    await probeOnce()
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ title: 'LIVE TRADING PAUSED', extra: { kind: 'CIRCUIT_BREAKER', thread: 'health' } })
    expect(told[0].body).toContain("the clock is 9 s behind Binance's")
    rig.server.skewMs = 50
    await probeOnce()
    await probeOnce()
    expect(told).toHaveLength(2)
    expect(told[1]).toMatchObject({ title: 'Live trading resumed', extra: { kind: 'CIRCUIT_BREAKER', thread: 'health-ok' } })
  })
})
