import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { COMMITTED_VICTIMS, COMMITTED_VICTIMS_READ_AT, setVictims } from '../../shared/incidents'
import { INCIDENT_VICTIMS_LINES, readVictimsFile, refreshUsable, type VictimRow } from '../../shared/incidentVictimsBuild'
import { writeJsonAtomic } from './atomicWrite'
import { inBackground } from './httpPacing'
import { listSymbols } from './marketService'
import { runInWorker } from './taskWorkerService'

// WHO A HACK'S VICTIM IS, KEPT CURRENT (V9 Stage 2's line, built in Stage 8, 6 November 2026). The news reader names a
// hack's victim by a table of the protocols and chains whose own token trades on Binance (shared/incidents.ts). The
// app ships with the table compiled on 6 November (shared/incidentVictims.json); once the table in use is a week old,
// DefiLlama's two public lists are read again, in the background lane of the request budgets, the table made again in
// the worker by the same rules (shared/incidentVictimsBuild.ts), kept in the profile and used from then on, so that a
// protocol listed since is named when it is hacked. A table read again is used only where it holds enough names and
// keeps most of those in use; else, or where a list cannot be read, the table in use stays and the lists are read again
// a day later. It reads two public lists and Binance's pairs the app holds; no key, no model, no order.

const FILE = 'incidentVictims.json'
const FIRST_TICK_MS = 5 * 60_000
const TICK_MS = 6 * 3600_000
const RETRY_MS = 86_400_000

/** What the service reads the world through: a test hands in its own. */
export const incidentVictimsSeam = {
  dir: (): string => app.getPath('userData'),
  nowMs: (): number => Date.now(),
  fetchText: async (url: string): Promise<string> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': 'Mozilla/5.0 (TraderSpider news reader)' } })
    if (!response.ok) throw new Error(`it answered ${response.status}`)
    return response.text()
  },
  tradable: async (): Promise<string[]> => [...new Set((await listSymbols('binance')).filter((pair) => pair.quoteAsset === 'USDT').map((pair) => pair.baseAsset.toUpperCase()))],
  build: async (protocolsText: string, chainsText: string, tradable: string[]): Promise<VictimRow[]> => {
    const outcome = await runInWorker('incidentVictims', { protocolsText, chainsText, tradable }, { timeoutMs: 60_000, maxOldGenerationSizeMb: 512 })
    if (!outcome.ok) throw new Error(outcome.reason === 'timeout' ? 'its lists took too long to read' : outcome.reason === 'memory' ? 'its lists are too large to read' : outcome.message)
    return outcome.result as VictimRow[]
  }
}

export interface IncidentVictimsState {
  /** The UTC day the table in use was read, YYYY-MM-DD. */
  readAt: string
  names: number
  source: 'committed' | 'refreshed'
}

let inUse: { rows: readonly VictimRow[] } & IncidentVictimsState = { rows: COMMITTED_VICTIMS, readAt: COMMITTED_VICTIMS_READ_AT, names: COMMITTED_VICTIMS.length, source: 'committed' }
let lastAttemptMs: number | null = null
let busy = false
let timer: ReturnType<typeof setInterval> | null = null
let firstTimer: ReturnType<typeof setTimeout> | null = null

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`)

export function incidentVictimsState(): IncidentVictimsState {
  return { readAt: inUse.readAt, names: inUse.names, source: inUse.source }
}

/** The profile's table where it was read after the committed one. */
async function load(): Promise<void> {
  let text: string
  try {
    text = await readFile(join(incidentVictimsSeam.dir(), FILE), 'utf-8')
  } catch {
    return
  }
  try {
    const file = readVictimsFile(JSON.parse(text) as unknown)
    if (file === null || !(dayMs(file.readAt) > dayMs(COMMITTED_VICTIMS_READ_AT)) || !refreshUsable(file.victims, COMMITTED_VICTIMS)) return
    inUse = { rows: file.victims, readAt: file.readAt, names: file.victims.length, source: 'refreshed' }
    setVictims(file.victims)
  } catch (error) {
    console.warn("Hack victims: the profile's table could not be read; the committed one is used:", describe(error))
  }
}

/** One turn: where the table in use is a week old, DefiLlama's lists read again and the table made from them used,
 * if it is usable. A list that cannot be read, or a table that is not usable, leaves the table in use, tried again a day
 * later. In the background lane, one turn at a time. */
export async function incidentVictimsTurn(): Promise<void> {
  if (busy) return
  busy = true
  try {
    const nowMs = incidentVictimsSeam.nowMs()
    if (nowMs - dayMs(inUse.readAt) < INCIDENT_VICTIMS_LINES.refreshEverySeconds * 1000) return
    if (lastAttemptMs !== null && nowMs - lastAttemptMs < RETRY_MS) return
    lastAttemptMs = nowMs
    await inBackground(async () => {
      const protocolsText = await incidentVictimsSeam.fetchText(INCIDENT_VICTIMS_LINES.sources[0])
      const chainsText = await incidentVictimsSeam.fetchText(INCIDENT_VICTIMS_LINES.sources[1])
      const rows = await incidentVictimsSeam.build(protocolsText, chainsText, await incidentVictimsSeam.tradable())
      if (!refreshUsable(rows, inUse.rows)) {
        console.warn(`Hack victims: DefiLlama's lists gave ${rows.length} names, too few or too unlike the ${inUse.names} in use; the table of ${inUse.readAt} stays.`)
        return
      }
      const readAt = new Date(nowMs).toISOString().slice(0, 10)
      await writeJsonAtomic(join(incidentVictimsSeam.dir(), FILE), { version: INCIDENT_VICTIMS_LINES.version, readAt, sources: INCIDENT_VICTIMS_LINES.sources, minTvlUsd: INCIDENT_VICTIMS_LINES.minTvlUsd, victims: rows })
      inUse = { rows, readAt, names: rows.length, source: 'refreshed' }
      setVictims(rows)
      console.info(`Hack victims: ${rows.length} names read from DefiLlama on ${readAt}, used from now on.`)
    })
  } catch (error) {
    console.warn('Hack victims: DefiLlama could not be read; the table in use stays:', describe(error))
  } finally {
    busy = false
  }
}

/** Uses the profile's table where it is newer, and starts the turns: the first a little after the app starts. Called
 * once, from main.ts. */
export async function startIncidentVictims(): Promise<void> {
  if (timer !== null) return
  await load()
  firstTimer = setTimeout(() => void incidentVictimsTurn(), FIRST_TICK_MS)
  timer = setInterval(() => void incidentVictimsTurn(), TICK_MS)
}

/** Test seam: as a new session finds it, the committed table in use. */
export function resetIncidentVictims(): void {
  if (timer !== null) clearInterval(timer)
  if (firstTimer !== null) clearTimeout(firstTimer)
  timer = null
  firstTimer = null
  inUse = { rows: COMMITTED_VICTIMS, readAt: COMMITTED_VICTIMS_READ_AT, names: COMMITTED_VICTIMS.length, source: 'committed' }
  lastAttemptMs = null
  busy = false
  setVictims(null)
}
