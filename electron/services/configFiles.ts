import { app } from 'electron'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { CONFIG_FILE_BASENAMES, CONFIG_FILE_VERSION, migrateConfigFile, type ConfigFileName, type ConfigFileNote } from '../../shared/configMigration'
import { writeJsonAtomic } from './atomicWrite'

// THE SETTINGS FILES, READ ONCE EACH AND TAKEN TO THIS CODE'S VERSION (the V5 document, §4 and
// §107; shared/configMigration.ts). Every store's service reads its file through here: the file is
// parsed, the migration steps it is behind run once, and when any ran the file is written back,
// stamped. What was read, and what happened, is kept for the effective-configuration card
// (electron/services/effectiveConfigService.ts), which says at start what was healed, so a value
// that quietly took its default is seen rather than guessed at.
//
// The heal of each store stays its own service's (shared/appDefaults.ts says which): this reads
// and migrates, and judges nothing.

const notes = new Map<ConfigFileName, ConfigFileNote>()
const raws = new Map<ConfigFileName, Record<string, unknown>>()

function pathOf(file: ConfigFileName): string {
  return join(app.getPath('userData'), CONFIG_FILE_BASENAMES[file])
}

/** A settings file as parsed, at this code's version: `{}` when it is not there or cannot be read.
 * A file behind the code's version is written back once the steps have run; one from a newer
 * version is left as written. */
export async function readConfigFile(file: ConfigFileName): Promise<Record<string, unknown>> {
  let parsed: unknown = null
  let present = false
  try {
    parsed = JSON.parse(await readFile(pathOf(file), 'utf-8'))
    present = true
  } catch {
    parsed = null
  }
  const migrated = migrateConfigFile(file, parsed)
  notes.set(file, {
    file,
    basename: CONFIG_FILE_BASENAMES[file],
    present,
    from: present ? migrated.from : null,
    to: migrated.to,
    applied: present ? migrated.applied : [],
    newer: migrated.newer
  })
  raws.set(file, migrated.raw)
  if (present && migrated.applied.length > 0) {
    try {
      await mkdir(app.getPath('userData'), { recursive: true })
      await writeJsonAtomic(pathOf(file), migrated.raw)
    } catch (error) {
      console.error(`${CONFIG_FILE_BASENAMES[file]} could not be written back at version ${CONFIG_FILE_VERSION}:`, error)
    }
  }
  return migrated.raw
}

/** What happened to each file read so far, in the order the files are listed. */
export function configFileNotes(): ConfigFileNote[] {
  return (Object.keys(CONFIG_FILE_BASENAMES) as ConfigFileName[]).flatMap((file) => {
    const note = notes.get(file)
    return note === undefined ? [] : [note]
  })
}

/** Each file as read (migrated, not healed), for the note of what the heal changed. */
export function rawConfigFiles(): Partial<Record<ConfigFileName, Record<string, unknown>>> {
  const out: Partial<Record<ConfigFileName, Record<string, unknown>>> = {}
  for (const [file, raw] of raws) if (notes.get(file)?.present) out[file] = raw
  return out
}

/** Forgets what was read, for tests that start a profile afresh. */
export function resetConfigFiles(): void {
  notes.clear()
  raws.clear()
}
