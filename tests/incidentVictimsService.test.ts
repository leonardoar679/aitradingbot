import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VictimRow } from '../shared/incidentVictimsBuild'

// electron/services/incidentVictimsService.ts (V9 Stage 8): the table a hack's victim is named by, read again from
// DefiLlama's two lists once it is a week old, in the background lane, used where it is usable and kept in the profile;
// the committed one, or the profile's newer one, at start; the table in use kept when a read fails or gives too little.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../electron/services/marketService', () => ({ listSymbols: async () => [] }))
vi.mock('../electron/services/taskWorkerService', () => ({ runInWorker: async () => ({ ok: false, reason: 'error', message: 'no worker in a test' }) }))

const HEADLINE = 'Zyntharion exploited for $12 million in a price oracle attack'
const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`)

async function setup(): Promise<{
  service: typeof import('../electron/services/incidentVictimsService')
  incidents: typeof import('../shared/incidents')
  calls: { what: string; lane: string }[]
  clock: { now: number }
  dir: string
  answer: { rows: VictimRow[] | null; fail: boolean }
}> {
  vi.resetModules()
  const service = await import('../electron/services/incidentVictimsService')
  const incidents = await import('../shared/incidents')
  const { laneNow } = await import('../electron/services/httpPacing')
  service.resetIncidentVictims()
  const dir = mkdtempSync(join(tmpdir(), 'victims-'))
  const calls: { what: string; lane: string }[] = []
  const clock = { now: day('2026-11-08') }
  const answer: { rows: VictimRow[] | null; fail: boolean } = { rows: [...incidents.COMMITTED_VICTIMS, ['zyntharion', 'ZYN', 'protocol']], fail: false }
  const seam = service.incidentVictimsSeam
  seam.dir = () => dir
  seam.nowMs = () => clock.now
  seam.fetchText = async (url) => {
    calls.push({ what: `read ${url}`, lane: laneNow() })
    if (answer.fail) throw new Error('it answered 502')
    return url
  }
  seam.tradable = async () => ['AAVE', 'ZYN']
  seam.build = async (protocolsText, chainsText, tradable) => {
    calls.push({ what: `build ${protocolsText} ${chainsText} ${tradable.join(',')}`, lane: laneNow() })
    return answer.rows ?? []
  }
  return { service, incidents, calls, clock, dir, answer }
}

afterEach(async () => (await import('../electron/services/incidentVictimsService')).resetIncidentVictims())

describe("the table a hack's victim is named by", () => {
  it('is the committed one at start, read again from DefiLlama once a week old, in the background lane, and then used and kept', async () => {
    const { service, incidents, calls, clock, dir } = await setup()
    await service.startIncidentVictims()
    expect(service.incidentVictimsState()).toEqual({ readAt: incidents.COMMITTED_VICTIMS_READ_AT, names: incidents.COMMITTED_VICTIMS.length, source: 'committed' })
    expect(incidents.victimOf(HEADLINE)).toBeNull()
    // Under a week after the committed one was read: nothing is read.
    clock.now = day('2026-11-12') + 23 * 3600_000
    await service.incidentVictimsTurn()
    expect(calls).toEqual([])
    clock.now = day('2026-11-13') + 3600_000
    await service.incidentVictimsTurn()
    expect(calls.map((call) => call.what)).toEqual(['read https://api.llama.fi/protocols', 'read https://api.llama.fi/v2/chains', 'build https://api.llama.fi/protocols https://api.llama.fi/v2/chains AAVE,ZYN'])
    expect(new Set(calls.map((call) => call.lane))).toEqual(new Set(['background']))
    expect(service.incidentVictimsState()).toEqual({ readAt: '2026-11-13', names: incidents.COMMITTED_VICTIMS.length + 1, source: 'refreshed' })
    expect(incidents.victimOf(HEADLINE)).toMatchObject({ victim: { name: 'zyntharion', token: 'ZYN' } })
    const kept = JSON.parse(readFileSync(join(dir, 'incidentVictims.json'), 'utf-8')) as { version: string; readAt: string; victims: VictimRow[] }
    expect(kept).toMatchObject({ version: 'incident-victims-v1', readAt: '2026-11-13' })
    expect(kept.victims).toContainEqual(['zyntharion', 'ZYN', 'protocol'])
    // A week from the new table's day, not before.
    calls.length = 0
    clock.now = day('2026-11-19') + 12 * 3600_000
    await service.incidentVictimsTurn()
    expect(calls).toEqual([])
  })

  it('stays as it is where the lists give too few names, or cannot be read, and is tried again a day later', async () => {
    const { service, incidents, calls, clock, dir, answer } = await setup()
    await service.startIncidentVictims()
    answer.rows = incidents.COMMITTED_VICTIMS.slice(0, 20)
    clock.now = day('2026-11-14')
    await service.incidentVictimsTurn()
    expect(calls).toHaveLength(3)
    expect(service.incidentVictimsState().source).toBe('committed')
    expect(existsSync(join(dir, 'incidentVictims.json'))).toBe(false)
    // An hour on: not tried again; a day on: tried, and DefiLlama fails.
    calls.length = 0
    clock.now = day('2026-11-14') + 3600_000
    await service.incidentVictimsTurn()
    expect(calls).toEqual([])
    answer.fail = true
    clock.now = day('2026-11-15')
    await service.incidentVictimsTurn()
    expect(calls.map((call) => call.what)).toEqual(['read https://api.llama.fi/protocols'])
    expect(service.incidentVictimsState().source).toBe('committed')
    expect(incidents.victimOf(HEADLINE)).toBeNull()
  })

  it("is the profile's at start where it was read after the committed one, and not an older or broken one", async () => {
    const { service, incidents, dir } = await setup()
    const write = (readAt: string, victims: VictimRow[]): void =>
      writeFileSync(join(dir, 'incidentVictims.json'), JSON.stringify({ version: 'incident-victims-v1', readAt, sources: [], minTvlUsd: 20e6, victims }))
    write('2026-11-20', [...incidents.COMMITTED_VICTIMS, ['zyntharion', 'ZYN', 'protocol']])
    await service.startIncidentVictims()
    expect(service.incidentVictimsState()).toMatchObject({ readAt: '2026-11-20', source: 'refreshed' })
    expect(incidents.victimOf(HEADLINE)).toMatchObject({ victim: { token: 'ZYN' } })
    for (const broken of [() => write('2026-11-01', [...incidents.COMMITTED_VICTIMS, ['zyntharion', 'ZYN', 'protocol']]), () => write('2026-11-20', [['zyntharion', 'ZYN', 'protocol']]), () => writeFileSync(join(dir, 'incidentVictims.json'), 'not json')]) {
      service.resetIncidentVictims()
      broken()
      await service.startIncidentVictims()
      expect(service.incidentVictimsState().source).toBe('committed')
      expect(incidents.victimOf(HEADLINE)).toBeNull()
    }
  })
})
