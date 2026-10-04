import { appendFile, mkdir, open, readdir } from 'fs/promises'
import { dirname } from 'path'

// Append-only files of JSON lines, one line per record, one file per UTC month.
//
// Lifted out of the AI call ledger when the market scanner needed the same thing for its events:
// two stores that are both only ever added to, and both read newest-first.
//
// APPENDED, NOT REWRITTEN. Every other store in this app is one JSON document replaced whole
// through writeJsonAtomic, which is right for a few kilobytes of state. A history only grows;
// rewriting the whole file for each row is quadratic, and a crash mid-rewrite would risk every row
// instead of one. An append can lose at most the line being written.
//
// WHAT A TORN LINE COSTS. A crash part-way through an append leaves a final line with no newline.
// A reader skips it and counts it. The danger is the NEXT append: written straight after the torn
// fragment it would join onto it and be unreadable too. So the first append to each file in a
// session checks how the file ends and starts a fresh line if it has to.

const NEWLINE = 0x0a

const appendQueues = new Map<string, Promise<void>>()
/** Files whose last byte is known to be a newline, because this process put it there. */
const cleanlyEnded = new Set<string>()

async function endsWithNewline(path: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return true // No file yet: nothing to be torn.
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) return true
    const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1)
    return buffer[0] === NEWLINE
  } finally {
    await handle.close()
  }
}

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  let prefix = ''
  if (!cleanlyEnded.has(path)) {
    if (!(await endsWithNewline(path))) prefix = '\n'
    cleanlyEnded.add(path)
  }
  await appendFile(path, `${prefix}${line}\n`, 'utf-8')
}

/** Appends one record as one line. Serialised per file so that lines land in the order they were
 * appended.
 *
 * Readers return newest-first by walking each file backwards, which is only true if file order is
 * append order. Concurrent appendFile calls go through a thread pool that does not keep it:
 * measured with sixty appended at once, they land shuffled. (They do not corrupt one another --
 * each small append is written whole -- so the queue is here for order, not for integrity.) */
export function appendJsonLine(path: string, record: unknown): Promise<void> {
  const previous = appendQueues.get(path) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => appendLine(path, JSON.stringify(record)))
  appendQueues.set(
    path,
    next.catch(() => undefined)
  )
  return next
}

/** The month files in `dir`, newest month first. `pattern` matches a file name and captures its
 * `YYYY-MM`. A directory that does not exist yet has no files, which is not an error. */
export async function listMonthFiles(dir: string, pattern: RegExp): Promise<{ name: string; month: string }[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names
    .map((name) => ({ name, month: pattern.exec(name)?.[1] ?? '' }))
    .filter((entry) => entry.month !== '')
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0))
}
