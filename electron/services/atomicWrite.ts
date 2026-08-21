import { writeFile, rename, rm } from 'fs/promises'

let writeCounter = 0

const RENAME_ATTEMPTS = 6

/** Windows fails a rename with EPERM/EACCES/EBUSY when another rename is targeting the same
 * destination at that instant (or a virus scanner/indexer holds a transient handle). Measured:
 * 40 overlapping writes to one store reliably produce it. POSIX has no such problem, but this
 * app ships on Windows, and a persist() that throws is worse than the plain writeFile it
 * replaced -- so back off briefly and retry rather than surfacing a spurious failure. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!transient || attempt >= RENAME_ATTEMPTS - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}

/** Writes JSON so that a crash can never leave a half-written file behind.
 *
 * Every persisted store here is read back with a `catch { use defaults }` around JSON.parse,
 * which cannot tell "this file does not exist yet" from "this file is truncated". A plain
 * writeFile truncates the target before writing, so losing power (or being killed) mid-write
 * leaves a file that parses as nothing -- and the very next persist() would then overwrite it
 * with that empty state, making the loss permanent. For livePositions.json in particular that
 * means real coins held on the exchange silently disappearing from the ledger, taking the
 * daily-loss gate's realized P&L down to zero with them.
 *
 * Writing to a sibling temp file and renaming avoids it: rename replaces the target in one step,
 * so a reader sees either the complete old file or the complete new one, never a partial write.
 * If the crash lands before the rename, the previous file is still intact.
 *
 * The temp name is unique per call rather than a fixed `<file>.tmp`. Persists are not serialised
 * anywhere -- a loop tick can be writing while an IPC handler writes the same store -- and with a
 * shared temp path the second writer's rename fails with ENOENT once the first has already moved
 * it. Distinct temps let overlapping writers each land independently, leaving last-writer-wins,
 * which is the same outcome the previous plain-writeFile code had. */
async function writeOnce(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${++writeCounter}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8')
    await renameWithRetry(tempPath, filePath)
  } catch (error) {
    // Never leave the temp behind on a failed write.
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

// One in-flight write per file. Overlapping persists to the same store would otherwise race their
// renames against each other, which on Windows surfaces as EPERM often enough to matter (measured
// at 25 concurrent writes per store, where retrying alone was not enough). Serialising also means
// only one temp per store exists at a time. Writers still get last-writer-wins, as they did with
// the plain writeFile this replaced, and each caller awaits its own write. Bounded in size: there
// are only a handful of store paths.
const writeQueues = new Map<string, Promise<void>>()

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => writeOnce(filePath, data))
  // Store a non-rejecting handle so one failed write cannot poison every later write on this path.
  writeQueues.set(
    filePath,
    next.catch(() => undefined)
  )
  return next
}
