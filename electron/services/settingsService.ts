import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import type { AppSettings } from '../../shared/ipc'

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  apiKey: null
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
  await writeFile(settingsPath(), JSON.stringify(cache, null, 2), 'utf-8')
  return cache
}
