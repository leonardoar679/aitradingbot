import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiCallFilter, AiCallRecord } from '../shared/aiLedger'
import type { AiWatchConfig } from '../shared/aiWatch'

// The order things happen in at the watch's gate (electron/services/aiWatchService.ts), with the
// setting and the ledger replaced by ones whose timing a test controls. What is checked here
// cannot be arranged with a real file: a ledger read that is still in the air while another call
// finishes.

const T = Date.parse('2026-09-10T12:07:00Z') / 1000
const WATCH: AiWatchConfig = { enabled: true, models: ['openai/gpt-5-mini'], maxEventsPerDay: 5, minBand: 'urgent', firstModelGates: false, confirmLive: false, askAt: 'detected' }

type Row = Pick<AiCallRecord, 'at' | 'source' | 'eventId'>
const ledger: Row[] = []
/** When set, a ledger read takes its snapshot at once and hands it over only when released. */
let hold: Promise<void> | null = null

vi.mock('../electron/services/aiConfigService', () => ({ getAiConfig: async () => ({ watch: WATCH }) }))
vi.mock('../electron/services/aiLedgerService', () => ({
  listAiCalls: async (filter: AiCallFilter) => {
    const snapshot = ledger.filter((row) => row.source === filter.source && row.at >= (filter.sinceSec ?? 0))
    if (hold !== null) await hold
    return { rows: snapshot, skippedLines: 0 }
  }
}))

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
const call = (eventId: string): { model: string; eventId: string; eventTime: number } => ({ model: 'openai/gpt-5-mini', eventId, eventTime: T })

beforeEach(() => {
  vi.resetModules()
  ledger.length = 0
  hold = null
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date((T + 20) * 1000))
  for (let index = 0; index < 4; index++) ledger.push({ at: T - 3600, source: 'watch', eventId: `earlier-${index}` })
  return (): void => {
    vi.useRealTimers()
  }
})

describe('withinWatchLimits', () => {
  it('counts an event whose call is still in the air', async () => {
    const { withinWatchLimits } = await import('../electron/services/aiWatchService')
    const answering = deferred()
    const fifth = withinWatchLimits(call('fifth'), () => answering.promise)
    await settle()
    // Nothing about the fifth is in the ledger yet, and the day has no place left all the same.
    await expect(withinWatchLimits(call('sixth'), async () => 'asked')).rejects.toThrow(/its 5 events for today/)
    // Another model for the event in the air is the same event.
    await expect(withinWatchLimits(call('fifth'), async () => 'asked')).resolves.toBe('asked')
    answering.resolve()
    await fifth
  })

  it('gives a place back when the call was never made', async () => {
    const { withinWatchLimits } = await import('../electron/services/aiWatchService')
    // The budget refused it: no row was written, so the event did not use one of the day's places.
    await expect(withinWatchLimits(call('fifth'), async () => Promise.reject(new Error('The daily AI budget is used up.')))).rejects.toThrow(/budget/)
    await expect(withinWatchLimits(call('sixth'), async () => 'asked')).resolves.toBe('asked')
  })

  it('finds a finished call in the ledger or in the air, and never in neither', async () => {
    const { withinWatchLimits } = await import('../electron/services/aiWatchService')
    const answering = deferred()
    // The fifth event's call is made, and is in the air.
    const fifth = withinWatchLimits(call('fifth'), async () => {
      await answering.promise
      ledger.push({ at: T + 25, source: 'watch', eventId: 'fifth' })
      return 'asked'
    })
    await settle()
    // A sixth event starts its check: its read of the ledger is taken now, before the fifth's row
    // is written, and arrives only after the fifth has finished.
    const reading = deferred()
    hold = reading.promise
    const sixth = withinWatchLimits(call('sixth'), async () => 'asked')
    const refused = expect(sixth).rejects.toThrow(/its 5 events for today/)
    await settle()
    hold = null
    answering.resolve()
    await settle()
    reading.resolve()
    await refused
    await expect(fifth).resolves.toBe('asked')
    // And afterwards the fifth is read from the ledger like any other.
    await expect(withinWatchLimits(call('seventh'), async () => 'asked')).rejects.toThrow(/its 5 events for today/)
  })
})
