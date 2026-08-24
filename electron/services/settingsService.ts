import { app } from 'electron'
import { join } from 'path'
import { readFile, mkdir } from 'fs/promises'
import { writeJsonAtomic } from './atomicWrite'
import type { AppSettings } from '../../shared/ipc'

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

async function load(): Promise<AppSettings> {
  if (cache) return cache
  try {
    const raw = await readFile(settingsPath(), 'utf-8')
    cache = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export async function getSettings(): Promise<AppSettings> {
  return load()
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await load()
  cache = { ...current, ...patch }
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(settingsPath(), cache)
  return cache
}
