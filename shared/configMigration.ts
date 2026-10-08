// A VERSION ON EVERY SETTINGS FILE, AND THE STEPS BETWEEN VERSIONS (the V5 document, §4 and §107).
//
// Every settings file the app writes -- settings.json, aiConfig.json, scanner.json, news.json,
// liveTrading.json -- is healed on every read: a missing value takes its default, an unusable one
// is repaired. That is the resolver the document asks for, and it stays. What a heal cannot do is
// change the MEANING of a value that is still readable: a field renamed, a unit changed, a switch
// whose sense was flipped. That is a migration: a numbered step, run once, that rewrites the file
// from the version it was written at to the version this code writes. The file carries its version
// (`configVersion`) so the steps run once and not on every start.
//
// Step 1 stamps the version and changes nothing else: a file written before 8 October 2026 has no
// version, and is read as version 0. A file from a NEWER version than this code knows is left as it
// is, unstamped: an older app must not rewrite what a newer one wrote.

export const CONFIG_FILE_VERSION = 1

export type ConfigFileName = 'settings' | 'aiConfig' | 'scanner' | 'news' | 'liveTrading'

export const CONFIG_FILE_NAMES: readonly ConfigFileName[] = ['settings', 'aiConfig', 'scanner', 'news', 'liveTrading']

/** The file each name is, in the profile folder. */
export const CONFIG_FILE_BASENAMES: Record<ConfigFileName, string> = {
  settings: 'settings.json',
  aiConfig: 'aiConfig.json',
  scanner: 'scanner.json',
  news: 'news.json',
  liveTrading: 'liveTrading.json'
}

export interface ConfigMigration {
  /** The version the file is at once this step has run. */
  to: number
  /** What the step did, in words, for the note at start. */
  what: string
  /** The file rewritten. A step that does not concern a file returns it unchanged. */
  run: (file: ConfigFileName, raw: Record<string, unknown>) => Record<string, unknown>
}

/** Every step there has been, in order. A new one is appended with the next number, and
 * CONFIG_FILE_VERSION is raised to it. */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [{ to: 1, what: 'stamped with its version', run: (_file, raw) => raw }]

export interface MigratedConfigFile {
  file: ConfigFileName
  /** The file's content once every due step has run, stamped. */
  raw: Record<string, unknown>
  /** The version the file was read at: 0 for one without a version. */
  from: number
  /** The version it is at now. */
  to: number
  /** The steps that ran, in words; empty when none were due. The caller writes the file back when
   * any did. */
  applied: string[]
  /** True for a file from a newer version than this code knows: left as read, nothing applied. */
  newer: boolean
}

/** A file's parsed content taken to this code's version. Anything that is not an object is read as
 * an empty file. */
export function migrateConfigFile(file: ConfigFileName, parsed: unknown): MigratedConfigFile {
  const raw: Record<string, unknown> = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {}
  const stored = raw.configVersion
  const from = typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0
  if (from > CONFIG_FILE_VERSION) return { file, raw, from, to: from, applied: [], newer: true }
  let current = raw
  const applied: string[] = []
  for (const step of CONFIG_MIGRATIONS) {
    if (step.to <= from) continue
    current = step.run(file, current)
    applied.push(step.what)
  }
  if (applied.length > 0) current = { ...current, configVersion: CONFIG_FILE_VERSION }
  return { file, raw: current, from, to: CONFIG_FILE_VERSION, applied, newer: false }
}

/** A file as this app writes it: its content, stamped with the version the code is at. */
export function stampedConfig<T extends object>(content: T): T & { configVersion: number } {
  return { ...content, configVersion: CONFIG_FILE_VERSION }
}

/** What happened to one file at start, for the note on the effective-configuration card. */
export interface ConfigFileNote {
  file: ConfigFileName
  basename: string
  /** False when the file was not there: a fresh install, or a store never written. */
  present: boolean
  /** The version read, 0 for none; null when the file was not there. */
  from: number | null
  /** The version it is at now. */
  to: number
  applied: string[]
  newer: boolean
}

/** The note in one line: how many files were stamped or migrated, and which are newer. */
export function describeConfigFiles(notes: ConfigFileNote[]): string {
  const absent = notes.filter((note) => !note.present).length
  const migrated = notes.filter((note) => note.present && note.applied.length > 0)
  const newer = notes.filter((note) => note.newer)
  const parts: string[] = []
  if (notes.length > 0 && absent === notes.length) parts.push(`A fresh install: every settings file is new, written at version ${CONFIG_FILE_VERSION} when first set.`)
  else if (absent > 0) parts.push(`${absent} settings ${absent === 1 ? 'file was' : 'files were'} not there yet and ${absent === 1 ? 'starts' : 'start'} at the defaults.`)
  if (migrated.length > 0) parts.push(migrated.map((note) => `${note.basename} ${note.applied.join(', ')} (from ${note.from} to ${note.to})`).join('; ') + '.')
  if (newer.length > 0) parts.push(`${newer.map((note) => note.basename).join(', ')} ${newer.length === 1 ? 'is' : 'are'} from a newer version of the app and ${newer.length === 1 ? 'was' : 'were'} left as written.`)
  if (parts.length === 0) parts.push(`Every settings file is at version ${CONFIG_FILE_VERSION}; nothing was migrated.`)
  return parts.join(' ')
}
