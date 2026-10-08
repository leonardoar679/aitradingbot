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
  return cache
}
