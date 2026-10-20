// A ZIP ARCHIVE, WRITTEN AND READ (V7.2-R Stage 2, 20 October 2026): what the research record's export is
// packed in, without a dependency. Deflate is handed in (the main process passes zlib's raw deflate and
// inflate), so this module is arithmetic on bytes: local headers, the central directory, the end record, and
// the CRC-32 every entry is checked by. No ZIP64: an archive holds under 65,535 entries and every size stays
// under 4 GiB, which an export of a fortnight's records is far below, and is refused otherwise. File names
// are UTF-8 (general-purpose flag bit 11).

export interface ZipEntry {
  /** The path inside the archive, with forward slashes. */
  name: string
  data: Uint8Array
  /** When the file was last changed; the archive keeps it to the two seconds DOS time allows. */
  mtime: Date
  /** The data already deflated (raw, as zlib's deflateRaw makes it), so that a caller can deflate off its
   * thread; deflated here where absent. */
  deflated?: Uint8Array
}

const TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** The CRC-32 (IEEE 802.3) of a run of bytes, as a ZIP archive checks each entry by. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A moment as the DOS time and date a ZIP header carries (UTC, two-second steps, from 1980). */
function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getUTCFullYear())
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  }
}

const MAX_ENTRIES = 65_535
const MAX_SIZE = 0xffffffff

/** The archive of the entries given, each deflated where that makes it smaller and stored where not. */
export function zipArchive(entries: readonly ZipEntry[], deflate: (data: Uint8Array) => Uint8Array = (): Uint8Array => { throw new Error('No deflate was given for an entry not deflated already') }): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new Error(`An archive holds at most ${MAX_ENTRIES} entries`)
  const encoder = new TextEncoder()
  const names = new Set<string>()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    if (entry.name === '' || entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').includes('..')) throw new Error(`Not a path inside an archive: ${entry.name}`)
    if (names.has(entry.name)) throw new Error(`The archive was given ${entry.name} twice`)
    names.add(entry.name)
    if (entry.data.length > MAX_SIZE) throw new Error(`${entry.name} is too large for an archive without ZIP64`)
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const deflated = entry.deflated ?? deflate(entry.data)
    const stored = deflated.length >= entry.data.length
    const body = stored ? entry.data : deflated
    const method = stored ? 0 : 8
    const { time, day } = dosDateTime(entry.mtime)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, time, true)
    lv.setUint16(12, day, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, entry.data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, day, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, entry.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    locals.push(local, body)
    centrals.push(central)
    offset += local.length + body.length
    if (offset > MAX_SIZE) throw new Error('The archive is too large without ZIP64')
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + centralSize + end.length)
  let at = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** The entries of an archive this module wrote (or any without ZIP64 or encryption), each checked by its
 * CRC-32; throws on anything that does not read. */
export function readZip(bytes: Uint8Array, inflate: (data: Uint8Array) => Uint8Array): { name: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let endAt = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      endAt = at
      break
    }
  }
  if (endAt < 0) throw new Error('Not a ZIP archive: no end record')
  const count = view.getUint16(endAt + 10, true)
  let at = view.getUint32(endAt + 16, true)
  const decoder = new TextDecoder()
  const out: { name: string; data: Uint8Array }[] = []
  for (let k = 0; k < count; k++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('A damaged central directory')
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localAt = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    if (view.getUint32(localAt, true) !== 0x04034b50) throw new Error(`A damaged local header for ${name}`)
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true)
    const body = bytes.subarray(dataAt, dataAt + size)
    const data = method === 0 ? body.slice() : method === 8 ? inflate(body) : null
    if (data === null) throw new Error(`${name} is packed by a method this reader does not read`)
    if (crc32(data) !== crc) throw new Error(`${name} does not match its checksum`)
    out.push({ name, data })
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}
