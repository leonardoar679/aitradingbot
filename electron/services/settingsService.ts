import { app } from 'electron'
import { join } from 'path'
import { mkdir } from 'fs/promises'
import { writeJsonAtomic } from './atomicWrite'
import type { AppSettings } from '../../shared/ipc'
import { stampedConfig } from '../../shared/configMigration'
import { readConfigFile } from './configFiles'

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  bots: [],
  botRuns: [],
  executors: [],
  routines: [],
  heldPositions: [],
  controllers: [],
  paperAccount: null
}

let cache: AppSettings | null = null
/** Told after every write with the settings before and after it (V7.2-R Stage 2): what the research folder's
 * trade log reads each paper order's opening, end and the paper account's money from. A listener that throws
 * is logged and skipped; the write stands. */
const writeListeners = new Set<(before: AppSettings, after: AppSettings) => void>()

export function onSettingsWritten(listener: (before: AppSettings, after: AppSettings) => void): () => void {
  writeListeners.add(listener)
  return () => void writeListeners.delete(listener)
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** settings.json read once, through the migration steps it is behind (configFiles.ts), over the
 * defaults: a key the file lacks is the default's, and each store in it is healed by its own reader. */
async function load(): Promise<AppSettings> {
  if (cache) return cache
  cache = { ...DEFAULT_SETTINGS, ...((await readConfigFile('settings')) as Partial<AppSettings>) }
  return cache
}

export async function getSettings(): Promise<AppSettings> {
  return load()
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await load()
  cache = { ...current, ...patch }
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(settingsPath(), stampedConfig(cache))
  const written = cache
  for (const listener of writeListeners) {
    try {
      listener(current, written)
    } catch (error) {
      console.error('A settings listener failed:', error)
    }
  }
  return cache
}
