import type { TraderFill } from './hyperliquid'
import type { RoundTrip } from './roundTrips'

// A FILE OF A TRADER'S TRADES (V8 Stage 7, 27 October 2026). A person may bring a trader's trades as a file -- an
// export of their own account, or a list someone shared -- in CSV or JSON, at most 5 MB. Nobody can check it: what it
// holds is UNVERIFIABLE, and said so wherever it is shown. It is read as fills -- a time, a symbol, a side, a price and
// a quantity each, a fee and a closed profit where given, each coin's position taken as flat where the file starts --
// or as round trips -- opening and closing times, a symbol, a side, entry and exit prices, and a quantity, a fee and a
// profit where given. Each row is checked, and a row out of its shape refused and counted, the first few with why. A
// time without a zone is read as UTC. Pure: the main process opens the file through its own dialog, and the worker
// reads it.

export const TRADER_FILE_LINES = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 100_000,
  /** The refusals said, the first few. */
  maxReasons: 5,
  /** A time before this, or more than a day after the file is read, is refused. */
  earliestMs: Date.UTC(2015, 0, 1)
} as const

/** The columns read, by the names exports give them: lower case, letters and digits only. */
const COLUMNS = {
  time: ['time', 'timestamp', 'date', 'datetime', 'dateutc', 'timeutc', 'tradetime', 'executiontime', 'filltime', 'ts', 'createdat'],
  openTime: ['opentime', 'opened', 'openedat', 'entrytime', 'opentimeutc', 'opendate'],
  closeTime: ['closetime', 'closed', 'closedat', 'exittime', 'closetimeutc', 'closedate'],
  symbol: ['symbol', 'coin', 'pair', 'instrument', 'instid', 'market', 'contract', 'contracts', 'asset', 'ticker'],
  side: ['side', 'direction', 'positionside', 'posside', 'tradeside'],
  price: ['price', 'px', 'avgprice', 'fillprice', 'execprice', 'tradeprice', 'executionprice', 'dealprice'],
  entryPrice: ['entryprice', 'openprice', 'avgentryprice', 'openavgpx', 'entry', 'avgopenprice'],
  exitPrice: ['exitprice', 'closeprice', 'avgexitprice', 'closeavgpx', 'exit', 'avgcloseprice'],
  qty: ['qty', 'quantity', 'size', 'sz', 'amount', 'filled', 'filledqty', 'execqty', 'volume'],
  fee: ['fee', 'fees', 'commission', 'tradingfee', 'feepaid'],
  pnl: ['realizedprofit', 'realizedpnl', 'closedpnl', 'pnl', 'profit', 'closedpl', 'netpnl']
} as const

type Column = keyof typeof COLUMNS

export interface TraderFileRead {
  kind: 'fills' | 'trips'
  fills: TraderFill[]
  trips: RoundTrip[]
  /** Rows read, rows refused, and why the first few were. */
  rows: number
  refusedRows: number
  reasons: string[]
  /** The file's columns as it names them. */
  columns: string[]
}

const normal = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** A CSV's rows. The separator is the header's most frequent of comma, semicolon and tab; a quoted field may hold any of
 * them and line breaks, a doubled quote within it a quote. Blank lines are skipped. */
export function csvRowsOf(text: string): string[][] {
  const lineEnd = text.search(/\r?\n/)
  const header = lineEnd < 0 ? text : text.slice(0, lineEnd)
  const separator = [',', ';', '\t'].map((candidate) => ({ candidate, count: header.split(candidate).length })).sort((a, b) => b.count - a.count)[0].candidate
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const endRow = (): void => {
    row.push(field)
    field = ''
    if (row.some((cell) => cell.trim() !== '')) rows.push(row)
    row = []
  }
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]
    if (quoted) {
      if (ch !== '"') field += ch
      else if (text[k + 1] === '"') {
        field += '"'
        k++
      } else quoted = false
    } else if (ch === '"' && field.trim() === '') {
      quoted = true
      field = ''
    } else if (ch === separator) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[k + 1] === '\n') k++
      endRow()
    } else field += ch
  }
  if (field !== '' || row.length > 0) endRow()
  return rows
}

/** A number as exports write them: thousands separated by commas, a unit after it ("0.5 USDT"). */
export function fileNumberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const match = /^\s*([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*[A-Za-z]*\s*$/.exec(value)
  if (match === null) return null
  const parsed = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

/** A time in milliseconds: epoch seconds or milliseconds, ISO 8601 with its zone, or a date and time without one --
 * read as UTC; null for anything else. */
export function fileTimeOf(value: unknown): number | null {
  if (typeof value === 'number') return !Number.isFinite(value) ? null : value >= 1e12 ? Math.round(value) : value >= 1e9 ? Math.round(value * 1000) : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (/^\d{10}(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)
  if (/^\d{13}$/.test(text)) return Number(text)
  const plain = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text)
  if (plain === null) return null
  const [year, month, day, hour, minute, second] = [plain[1], plain[2], plain[3], plain[4], plain[5], plain[6] ?? '0'].map(Number)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, plain[7] === undefined ? 0 : Math.round(Number(plain[7]) * 1000))
  if (new Date(ms).getUTCDate() !== day) return null
  const zone = plain[8]
  if (zone === undefined || zone === 'Z') return ms
  const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(zone) as RegExpExecArray
  return ms - (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000
}

/** A symbol's coin: BTC of BTCUSDT, BTC-USDT-SWAP, BTC/USDT:USDT, BTC-PERP or BTC. */
export function fileCoinOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toUpperCase()
  const quoted = /^([A-Z0-9]+?)[-_/]?(?:USDT|USDC|BUSD|USD)(?:[-_:/](?:USDT|USDC|USD|SWAP|PERP))*(?:-?PERP)?$/.exec(text)
  if (quoted !== null) return quoted[1]
  const perp = /^([A-Z0-9]+)-PERP$/.exec(text)
  if (perp !== null) return perp[1]
  return /^[A-Z0-9]{1,15}$/.test(text) ? text : null
}

const fillSideOf = (value: unknown): 'buy' | 'sell' | null => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['buy', 'b', 'bid', 'long', 'open long', 'close short', 'buy/long'].includes(text)) return 'buy'
  if (['sell', 's', 'a', 'ask', 'short', 'open short', 'close long', 'sell/short'].includes(text)) return 'sell'
  return null
}

const tripSideOf = (value: unknown): 'long' | 'short' | null => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['long', 'buy', 'b', 'buy/long'].includes(text)) return 'long'
  if (['short', 'sell', 's', 'sell/short'].includes(text)) return 'short'
  return null
}

/** The file's rows as records keyed by normalised column names, its columns as it names them, and its format. */
function recordsOf(text: string): { records: Map<string, unknown>[]; columns: string[]; format: 'csv' | 'json' } | { refused: string } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const start = body.trimStart()
  if (start.startsWith('[') || start.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { refused: 'The file is not JSON this app can read.' }
    }
    const holder = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    const list = Array.isArray(parsed) ? parsed : (['trades', 'fills', 'positions', 'data', 'list', 'rows'].map((name) => holder?.[name]).find(Array.isArray) as unknown[] | undefined)
    if (list === undefined) return { refused: 'The JSON holds no list of trades: an array, or one under "trades", "fills", "positions" or "data".' }
    const columns = new Set<string>()
    const records = list.map((item) => {
      const entry = new Map<string, unknown>()
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        for (const [name, value] of Object.entries(item as Record<string, unknown>)) {
          columns.add(name)
          entry.set(normal(name), value)
        }
      }
      return entry
    })
    return { records, columns: [...columns].slice(0, 40), format: 'json' }
  }
  const rows = csvRowsOf(body)
  if (rows.length < 2) return { refused: 'The file holds no row of trades under a header.' }
  const header = rows[0].map((name) => name.trim())
  const keys = header.map(normal)
  return { records: rows.slice(1).map((row) => new Map(keys.map((key, k) => [key, row[k] ?? ''] as [string, unknown]))), columns: header.slice(0, 40), format: 'csv' }
}

const find = (records: readonly Map<string, unknown>[], column: Column): string | null => {
  const keys = new Set(records.slice(0, 50).flatMap((entry) => [...entry.keys()]))
  return COLUMNS[column].find((name) => keys.has(name)) ?? null
}

/** A file's trades read; a refusal where the file holds none in a shape this app reads. */
export function traderFileOf(text: string, nowMs: number, lines: typeof TRADER_FILE_LINES = TRADER_FILE_LINES): TraderFileRead | { refused: string } {
  if (text.length > lines.maxBytes) return { refused: `The file is larger than ${lines.maxBytes / 1024 / 1024} MB.` }
  const read = recordsOf(text)
  if ('refused' in read) return read
  const { records, columns, format } = read
  if (records.length > lines.maxRows) return { refused: `The file holds ${records.length.toLocaleString('en-US')} rows, over ${lines.maxRows.toLocaleString('en-US')}.` }
  const col = Object.fromEntries((Object.keys(COLUMNS) as Column[]).map((name) => [name, find(records, name)])) as Record<Column, string | null>
  const asTrips = col.openTime !== null && col.closeTime !== null && col.symbol !== null && col.side !== null && col.entryPrice !== null && col.exitPrice !== null
  const asFills = col.time !== null && col.symbol !== null && col.side !== null && col.price !== null && col.qty !== null
  if (!asTrips && !asFills) {
    return {
      refused: `The file needs, for each trade, opening and closing times, a symbol, a side and entry and exit prices -- or, for each fill, a time, a symbol, a side, a price and a quantity. Its columns: ${columns.join(', ') || 'none'}.`
    }
  }
  const reasons: string[] = []
  let refused = 0
  const refuse = (row: number, why: string): void => {
    refused++
    // A CSV's line as a person finds it, the header its first; a JSON list's item, the first 1.
    if (reasons.length < lines.maxReasons) reasons.push(`${format === 'csv' ? `line ${row + 2}` : `item ${row + 1}`}: ${why}`)
  }
  const value = (entry: Map<string, unknown>, column: Column): unknown => (col[column] === null ? undefined : entry.get(col[column] as string))
  const timeIn = (ms: number | null): boolean => ms !== null && ms >= lines.earliestMs && ms <= nowMs + 86_400_000
  const optional = (entry: Map<string, unknown>, column: Column): number | null => {
    const raw = value(entry, column)
    return raw === undefined || raw === '' || raw === null ? null : fileNumberOf(raw)
  }

  if (asTrips) {
    const trips: RoundTrip[] = []
    records.forEach((entry, row) => {
      const coin = fileCoinOf(value(entry, 'symbol'))
      const side = tripSideOf(value(entry, 'side'))
      const openedAtMs = fileTimeOf(value(entry, 'openTime'))
      const closedAtMs = fileTimeOf(value(entry, 'closeTime'))
      const entryPx = fileNumberOf(value(entry, 'entryPrice'))
      const exitPx = fileNumberOf(value(entry, 'exitPrice'))
      if (coin === null) return refuse(row, 'a symbol it cannot read')
      if (side === null) return refuse(row, 'a side that is not long or short')
      if (!timeIn(openedAtMs) || !timeIn(closedAtMs)) return refuse(row, 'a time it cannot read (ISO 8601, YYYY-MM-DD hh:mm:ss in UTC, or epoch seconds or milliseconds), or out of range')
      if ((closedAtMs as number) <= (openedAtMs as number)) return refuse(row, 'closed before it opened')
      if (entryPx === null || !(entryPx > 0) || exitPx === null || !(exitPx > 0)) return refuse(row, 'a price that is not a positive number')
      const qty = optional(entry, 'qty')
      const fee = optional(entry, 'fee')
      const pnl = optional(entry, 'pnl')
      const size = qty === null ? 0 : Math.abs(qty)
      const sign = side === 'long' ? 1 : -1
      const fees = fee === null ? 0 : Math.abs(fee)
      const realized = pnl ?? sign * (exitPx - entryPx) * size
      trips.push({
        coin,
        side,
        openedAtMs: openedAtMs as number,
        closedAtMs: closedAtMs as number,
        entryPx,
        exitPx,
        maxSize: size,
        entryNotional: size * entryPx,
        realizedPnl: realized,
        fees,
        rebates: 0,
        funding: 0,
        net: realized - fees,
        movePct: sign * (exitPx / entryPx - 1) * 100,
        fills: 2
      })
    })
    if (trips.length === 0) return { refused: `No row of the file could be read${reasons[0] !== undefined ? ` -- ${reasons[0]}` : ''}.` }
    return { kind: 'trips', fills: [], trips: trips.sort((a, b) => a.closedAtMs - b.closedAtMs), rows: records.length, refusedRows: refused, reasons, columns }
  }

  const rows: { row: number; coin: string; timeMs: number; side: 'buy' | 'sell'; px: number; sz: number; fee: number; closedPnl: number }[] = []
  records.forEach((entry, row) => {
    const coin = fileCoinOf(value(entry, 'symbol'))
    const side = fillSideOf(value(entry, 'side'))
    const timeMs = fileTimeOf(value(entry, 'time'))
    const px = fileNumberOf(value(entry, 'price'))
    const qty = fileNumberOf(value(entry, 'qty'))
    if (coin === null) return refuse(row, 'a symbol it cannot read')
    if (side === null) return refuse(row, 'a side that is not buy or sell')
    if (!timeIn(timeMs)) return refuse(row, 'a time it cannot read (ISO 8601, YYYY-MM-DD hh:mm:ss in UTC, or epoch seconds or milliseconds), or out of range')
    if (px === null || !(px > 0) || qty === null || qty === 0) return refuse(row, 'a price or a quantity that is not a positive number')
    const fee = optional(entry, 'fee')
    rows.push({ row, coin, timeMs: timeMs as number, side, px, sz: Math.abs(qty), fee: fee === null ? 0 : Math.abs(fee), closedPnl: optional(entry, 'pnl') ?? 0 })
  })
  if (rows.length === 0) return { refused: `No row of the file could be read${reasons[0] !== undefined ? ` -- ${reasons[0]}` : ''}.` }
  // Each coin's position, flat where the file starts, carried fill by fill in time and then in the file's order.
  rows.sort((a, b) => a.timeMs - b.timeMs || a.row - b.row)
  const position = new Map<string, number>()
  const fills: TraderFill[] = rows.map((entry) => {
    const start = position.get(entry.coin) ?? 0
    position.set(entry.coin, start + (entry.side === 'buy' ? entry.sz : -entry.sz))
    return { coin: entry.coin, timeMs: entry.timeMs, side: entry.side, px: entry.px, sz: entry.sz, startPosition: start, dir: '', closedPnl: entry.closedPnl, fee: entry.fee, feeToken: 'USDT', crossed: false, tid: entry.row + 1, oid: 0, label: 'UNVERIFIABLE' }
  })
  return { kind: 'fills', fills, trips: [], rows: records.length, refusedRows: refused, reasons, columns }
}
