import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { healAlertRecord, healPaperRefusalRecord, healRecordFilter, parseRecordLines, recordMonthKey } from '../shared/records'
import { resetAlerts, seedAlerts, addAlert, subscribeAlerts, unseenCount, bannerAlerts } from '../src/news/alertStore'

// THE RECORDS ON FILE (shared/records.ts, electron/services/recordStoreService.ts): the app's own
// paper trades refused, and the alerts told, one JSON line each in a file per UTC month, written as
// the renderer tells them and read back by span. A line that is not a record is skipped and counted.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))

const T = Date.parse('2026-10-01T00:10:00Z') / 1000
const EARLIER = Date.parse('2026-09-30T23:50:00Z') / 1000

async function store() {
  return await import('../electron/services/recordStoreService')
}

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'records-'))
})

describe('a refusal on file', () => {
  it('is written as one line in its month, read back newest first by span, and never twice for one id', async () => {
    const { appendPaperRefusal, readPaperRefusalsSince } = await store()
    expect(await appendPaperRefusal({ id: 'r1', at: EARLIER, source: 'watch', symbol: 'SOLUSDT', text: 'No paper trade: 3 are open already.', eventId: 'binance:SOLUSDT:1', model: 'm', callId: 'c1', side: 'buy' })).toMatchObject({ id: 'r1' })
    expect(await appendPaperRefusal({ id: 'r2', at: T, source: 'news', symbol: 'ADAUSDT', text: 'ADA: the paper short was off.' })).toMatchObject({ id: 'r2', source: 'news' })
    const dir = join(process.env.AI_TEST_USER_DATA as string, 'paperRefusals')
    expect(readdirSync(dir).sort()).toEqual(['refusals-2026-09.jsonl', 'refusals-2026-10.jsonl'])
    expect(readFileSync(join(dir, 'refusals-2026-10.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(1)

    const all = await readPaperRefusalsSince({ sinceSec: EARLIER - 10 })
    expect(all.rows.map((row) => row.id)).toEqual(['r2', 'r1'])
    expect(all.rows[1]).toEqual({ id: 'r1', at: EARLIER, source: 'watch', symbol: 'SOLUSDT', text: 'No paper trade: 3 are open already.', eventId: 'binance:SOLUSDT:1', model: 'm', callId: 'c1', side: 'buy' })
    expect((await readPaperRefusalsSince({ sinceSec: T })).rows.map((row) => row.id)).toEqual(['r2'])
    expect((await readPaperRefusalsSince({ sinceSec: EARLIER - 10, limit: 1 })).rows.map((row) => row.id)).toEqual(['r2'])
  })

  it('refuses what is not a refusal, and skips and counts a line that is not one', async () => {
    const { appendPaperRefusal, readPaperRefusalsSince } = await store()
    expect(await appendPaperRefusal({ id: 'x', at: T, source: 'robot', symbol: 'SOLUSDT', text: 'no' })).toBeNull()
    expect(await appendPaperRefusal({ id: 'x', at: 'now', source: 'watch', symbol: 'SOLUSDT', text: 'no' })).toBeNull()
    expect(await appendPaperRefusal('junk')).toBeNull()
    expect(healPaperRefusalRecord({ id: 'x', at: T, source: 'watch', symbol: 'SOLUSDT', text: 'no', side: 'sideways', eventId: 42 })).toEqual({ id: 'x', at: T, source: 'watch', symbol: 'SOLUSDT', text: 'no' })
    // The restart stage (8 October 2026) is kept; any other word is not a stage.
    expect(healPaperRefusalRecord({ id: 'x', at: T, source: 'watch', symbol: 'SOLUSDT', text: 'no', stage: 'restart' })).toEqual({ id: 'x', at: T, source: 'watch', symbol: 'SOLUSDT', text: 'no', stage: 'restart' })
    expect(healPaperRefusalRecord({ id: 'x', at: T, source: 'watch', symbol: 'SOLUSDT', text: 'no', stage: 'later' })).toEqual({ id: 'x', at: T, source: 'watch', symbol: 'SOLUSDT', text: 'no' })
    expect(parseRecordLines('{"id":"a","at":1,"source":"watch","symbol":"S","text":"t"}\nnot json\n{"id":"b"}\n', healPaperRefusalRecord)).toEqual({
      rows: [{ id: 'a', at: 1, source: 'watch', symbol: 'S', text: 't' }],
      skipped: 2
    })
    expect((await readPaperRefusalsSince({ sinceSec: 0 })).rows).toEqual([])
  })

  it('opens no month file older than the span, which is where a torn line in an old month would be counted', async () => {
    const { appendPaperRefusal, readPaperRefusalsSince } = await store()
    await appendPaperRefusal({ id: 'r1', at: T, source: 'watch', symbol: 'SOLUSDT', text: 'no' })
    const dir = join(process.env.AI_TEST_USER_DATA as string, 'paperRefusals')
    writeFileSync(join(dir, 'refusals-2024-01.jsonl'), 'torn line that is not json\n')
    expect(await readPaperRefusalsSince({ sinceSec: T - 60 })).toEqual({ rows: [{ id: 'r1', at: T, source: 'watch', symbol: 'SOLUSDT', text: 'no' }], skippedLines: 0 })
    expect((await readPaperRefusalsSince({ sinceSec: 0 })).skippedLines).toBe(1)
  })

  it('reads the filter as one: a time, and a limit held to the range', () => {
    expect(healRecordFilter({ sinceSec: T, limit: 5 })).toEqual({ sinceSec: T, limit: 5 })
    expect(healRecordFilter({})).toEqual({ sinceSec: 0, limit: 2000 })
    expect(healRecordFilter({ sinceSec: -5, limit: 1e9 })).toEqual({ sinceSec: 0, limit: 20_000 })
    expect(healRecordFilter('junk')).toEqual({ sinceSec: 0, limit: 2000 })
    expect(recordMonthKey(T)).toBe('2026-10')
    expect(recordMonthKey(EARLIER)).toBe('2026-09')
  })
})

describe('an alert on file', () => {
  it('is written as told and read back by span, with only an https link kept', async () => {
    const { appendAlert, readAlertsSince } = await store()
    expect(await appendAlert({ id: 'story-1', at: T, severity: 'high', title: 'HIGH: a hack', body: 'Somewhere lost funds.', url: 'https://www.coindesk.com/a' })).toMatchObject({ id: 'story-1', url: 'https://www.coindesk.com/a' })
    expect(await appendAlert({ id: 'story-2', at: T + 60, severity: 'watch', title: 'WATCH: a listing', body: 'A coin listed.', url: 'http://plain.example/a' })).toEqual({ id: 'story-2', at: T + 60, severity: 'watch', title: 'WATCH: a listing', body: 'A coin listed.' })
    expect(await appendAlert({ id: 'bad', at: T, severity: 'loud', title: 't', body: 'b' })).toBeNull()
    expect(healAlertRecord({ id: 'x', at: T, severity: 'critical', title: 't', body: 'b', url: 'javascript:alert(1)' })).toEqual({ id: 'x', at: T, severity: 'critical', title: 't', body: 'b' })
    // The sound a notice made is kept, and only one of the five (V6 Stage 13).
    expect(healAlertRecord({ id: 's', at: T, severity: 'watch', title: 't', body: 'b', kind: 'MODEL_DEGRADED', sound: 'none' })).toEqual({ id: 's', at: T, severity: 'watch', title: 't', body: 'b', kind: 'MODEL_DEGRADED', sound: 'none' })
    expect(healAlertRecord({ id: 's', at: T, severity: 'high', title: 't', body: 'b', sound: 'warning' })?.sound).toBe('warning')
    expect(healAlertRecord({ id: 's', at: T, severity: 'high', title: 't', body: 'b', sound: 'siren' })).not.toHaveProperty('sound')
    expect((await readAlertsSince({ sinceSec: T + 1 })).rows.map((row) => row.id)).toEqual(['story-2'])
    // Written with its sound, it is read back with it.
    expect(await appendAlert({ id: 'heard', at: T + 120, severity: 'high', title: 'STOP: SOLUSDT', body: 'Hit.', kind: 'STOP_TRIGGERED', sound: 'warning' })).toMatchObject({ sound: 'warning' })
    expect((await readAlertsSince({ sinceSec: T + 100 })).rows.find((row) => row.id === 'heard')?.sound).toBe('warning')
    expect((await readAlertsSince({ sinceSec: 0 })).rows.map((row) => row.id)).toEqual(['heard', 'story-2', 'story-1'])
  })
})

describe('the alerts read back on start', () => {
  beforeEach(() => resetAlerts())

  it('are kept as told, seen and dismissed already, newest first, and never twice for one id', () => {
    let seen: readonly { id: string; seen: boolean; dismissed: boolean }[] = []
    subscribeAlerts((alerts) => {
      seen = alerts
    })
    addAlert({ id: 'live-1', severity: 'critical', title: 'CRITICAL: now', body: 'b', at: T + 300 })
    seedAlerts([
      { id: 'old-1', at: T, severity: 'high', title: 'HIGH: earlier', body: 'b' },
      { id: 'live-1', at: T + 300, severity: 'critical', title: 'CRITICAL: now', body: 'b' },
      { id: 'old-2', at: T + 100, severity: 'critical', title: 'CRITICAL: earlier', body: 'b' }
    ])
    expect(seen.map((alert) => alert.id)).toEqual(['live-1', 'old-2', 'old-1'])
    expect(seen.find((alert) => alert.id === 'live-1')).toMatchObject({ seen: false, dismissed: false })
    expect(seen.find((alert) => alert.id === 'old-2')).toMatchObject({ seen: true, dismissed: true })
    // The badge counts the live one alone, and the banner shows it alone: nothing old is raised again.
    expect(unseenCount(seen)).toBe(1)
    expect(bannerAlerts(seen).map((alert) => alert.id)).toEqual(['live-1'])
  })
})
