import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  EXPORT_SOURCES,
  PAPER_TRADE_COLUMNS,
  RESEARCH_LINES,
  aiRequestCsvRow,
  aiRequestLine,
  csvField,
  csvOf,
  exportFileName,
  exportSourceOf,
  exportsToSweep,
  holdsSecretField,
  inExportWindow,
  nextDailyExportAt,
  originOf,
  paperAccountEvents,
  paperOrderEvents,
  paperTradeRows,
  redactSecrets,
  scrubKeyPatterns,
  type PaperOrderEvent
} from '../shared/research'
import { crc32, readZip, zipArchive } from '../shared/zip'
import type { AiCallRecord } from '../shared/aiLedger'
import type { ExecutorConfig } from '../shared/ipc'

// THE RESEARCH RECORD'S PARTS (shared/zip.ts, shared/research.ts; V7.2-R Stage 2): the archive written and read
// back whole and checked; the allowlist naming no key file; the redactor leaving out every secret field at any
// depth; the window; the exports kept; each paper order's life and the account's money once; an AI call's line.

const deflate = (data: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(data))
const inflate = (data: Uint8Array): Uint8Array => new Uint8Array(inflateRawSync(data))
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const text = (data: Uint8Array): string => new TextDecoder().decode(data)

describe('the archive', () => {
  it('checks entries by the CRC-32 every ZIP reader knows', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('reads back every entry whole: deflated where that is smaller, stored where not, names in UTF-8', () => {
    const long = 'forecast,outcome\n'.repeat(500)
    const entries = [
      { name: 'manifest.json', data: bytes('{"a":1}'), mtime: new Date('2026-10-20T07:00:00Z') },
      { name: 'forecasts/predictions-2026-10.jsonl', data: bytes(long), mtime: new Date('2026-10-19T23:59:58Z') },
      { name: 'market/news/feed-2026-10 — ünïcode.jsonl', data: bytes('x'), mtime: new Date('2026-10-20T00:00:00Z') },
      { name: 'empty.txt', data: new Uint8Array(), mtime: new Date('2026-10-20T00:00:00Z') }
    ]
    const archive = zipArchive(entries, deflate)
    const read = readZip(archive, inflate)
    expect(read.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name))
    expect(read.map((entry) => text(entry.data))).toEqual(entries.map((entry) => text(entry.data)))
    // The repeated file was deflated: the archive is far smaller than it; the short one, which deflate only
    // grows, was stored (the method at offset 8 of each local header: 0 stored, 8 deflated).
    expect(archive.length).toBeLessThan(long.length / 5)
    const header = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    expect(header.getUint16(8, true)).toBe(0)
    expect(header.getUint16(30 + 'manifest.json'.length + 7 + 8, true)).toBe(8)
    // An entry deflated beforehand is taken as given.
    const pre = zipArchive([{ ...entries[1], deflated: deflate(entries[1].data) }])
    expect(text(readZip(pre, inflate)[0].data)).toBe(long)
  })

  it('refuses a path outside the archive, a name twice, and an entry deflated nowhere', () => {
    const at = new Date('2026-10-20T00:00:00Z')
    expect(() => zipArchive([{ name: '../x', data: bytes('x'), mtime: at }], deflate)).toThrow(/Not a path inside an archive/)
    expect(() => zipArchive([{ name: '/x', data: bytes('x'), mtime: at }], deflate)).toThrow(/Not a path inside an archive/)
    expect(() => zipArchive([{ name: 'a\\b', data: bytes('x'), mtime: at }], deflate)).toThrow(/Not a path inside an archive/)
    expect(() =>
      zipArchive(
        [
          { name: 'a', data: bytes('x'), mtime: at },
          { name: 'a', data: bytes('y'), mtime: at }
        ],
        deflate
      )
    ).toThrow(/twice/)
    expect(() => zipArchive([{ name: 'a', data: bytes('x'), mtime: at }])).toThrow(/No deflate/)
  })

  it('finds a damaged entry by its checksum, and a file that is no archive', () => {
    const archive = zipArchive([{ name: 'a.txt', data: bytes('hello world, hello world'), mtime: new Date('2026-10-20T00:00:00Z') }], () => new Uint8Array(1000))
    // Stored (the "deflate" here only grew it): flip a byte of the data.
    archive[30 + 'a.txt'.length] ^= 0xff
    expect(() => readZip(archive, inflate)).toThrow(/does not match its checksum/)
    expect(() => readZip(bytes('not a zip at all'), inflate)).toThrow(/no end record/)
  })
})

describe('the allowlist', () => {
  it('names no key file, and never the settings or the AI config as they lie on disk', () => {
    for (const [folder, name] of [
      ['', 'credentials.json'],
      ['', 'aiCredentials.json'],
      ['', 'aiCredentials.json.bak-openai-20261003-182504'],
      ['', 'settings.json'],
      ['', 'aiConfig.json'],
      ['', 'Local State'],
      ['Network', 'Cookies'],
      ['forecastModels', 'run-20261017-0030']
    ]) {
      expect(exportSourceOf(folder, name), `${folder}/${name}`).toBeNull()
    }
    expect(EXPORT_SOURCES.every((source) => !/credential|Local State|Network|Cache/i.test(source.from))).toBe(true)
    expect(exportSourceOf('forecasts', 'predictions-2026-10.jsonl')?.to).toBe('forecasts')
    expect(exportSourceOf('trader-spider-research/config', 'settings.json')?.to).toBe('config')
    expect(exportSourceOf('forecastData', 'BTCUSDT-2026-10.jsonl')?.to).toBe('market/price-history')
  })

  it("packs a month or a day the fortnight touches, and every file of a source that keeps none by date", () => {
    const now = Date.parse('2026-10-20T07:00:00Z') / 1000
    const forecasts = exportSourceOf('forecasts', 'predictions-2026-10.jsonl')!
    expect(inExportWindow(forecasts, 'predictions-2026-10.jsonl', now)).toBe(true)
    expect(inExportWindow(forecasts, 'predictions-2026-09.jsonl', now)).toBe(false)
    // Fourteen days before 3 October reach into September.
    expect(inExportWindow(forecasts, 'outcomes-2026-09.jsonl', Date.parse('2026-10-03T00:00:00Z') / 1000)).toBe(true)
    const tape = exportSourceOf('forecasts', 'tape-2026-10-06.jsonl')!
    expect(inExportWindow(tape, 'tape-2026-10-06.jsonl', now)).toBe(true)
    expect(inExportWindow(tape, 'tape-2026-10-05.jsonl', now)).toBe(false)
    expect(inExportWindow(tape, 'tape-2026-10-20.jsonl', now)).toBe(true)
    const current = exportSourceOf('forecastModels', 'current.json')!
    expect(inExportWindow(current, 'current.json', now)).toBe(true)
    expect(RESEARCH_LINES.exportWindowDays).toBe(14)
  })
})

describe('the redactor', () => {
  it('leaves out every secret field at any depth, and keeps a field that only contains a secret word', () => {
    const settings = { apiKey: 'K', theme: 'dark', bots: [{ id: 'b', aiModel: 'x', token: 'T' }], executors: [{ forecast: { classKey: 'large/hour1/trend' } }], keepRunningWhenClosed: true, nested: { deeper: { Password: 'p', apiPassphraseEnc: 'e' } } }
    const redacted = redactSecrets(settings)
    expect(redacted).toEqual({ theme: 'dark', bots: [{ id: 'b', aiModel: 'x' }], executors: [{ forecast: { classKey: 'large/hour1/trend' } }], keepRunningWhenClosed: true, nested: { deeper: {} } })
    expect(holdsSecretField(settings)).toBe(true)
    expect(holdsSecretField(redacted)).toBe(false)
    // The original is untouched.
    expect(settings.apiKey).toBe('K')
  })

  it('replaces every value shaped like a key wherever it stands, and keeps a SHA-256 and the words of a link (V8 Stage 10)', () => {
    const keys = [`sk-or-v1-${'0a'.repeat(32)}`, `sk-${'Ab3'.repeat(16)}`, `sk-proj-${'xY9_'.repeat(20)}`, `bg_${'c4'.repeat(16)}`, `${'aB1'.repeat(21)}c`]
    // Found by the in-app check: a story on SK Hynix had its link cut by the sk- pattern.
    const kept = ['f0'.repeat(32), 'https://decrypt.co/382114/chip-maker-sk-hynix-posts-record-quarter-as-ai-memory-demand-overwhelms-supply', 'https://example.com/sk-telecom-q3-2026-earnings-beat-estimates', 'https://example.com/news/sk-Hynix-Raises-Its-Memory-Outlook']
    const { text: out, scrubbed } = scrubKeyPatterns([...keys, ...kept].join(' '))
    expect(out).toBe([...keys.map(() => '[redacted]'), ...kept].join(' '))
    expect(scrubbed).toBe(keys.length)
  })
})

describe('the exports', () => {
  it('are named by their minute, kept fourteen, and made daily at 00:05 UTC', () => {
    const at = Date.parse('2026-10-20T00:05:00Z') / 1000
    expect(exportFileName(at)).toBe('trader-spider-report-2026-10-20-0005.zip')
    const names = Array.from({ length: 16 }, (_, k) => exportFileName(at - k * 86_400))
    expect(exportsToSweep([...names, 'other.zip'])).toEqual([names[14], names[15]])
    expect(nextDailyExportAt(at - 60)).toBe(at)
    expect(nextDailyExportAt(at)).toBe(at + 86_400)
    expect(nextDailyExportAt(at + 3600)).toBe(at + 86_400)
  })
})

const position = (patch: Partial<ExecutorConfig>): ExecutorConfig =>
  ({ id: 'p1', name: 'x', type: 'position', exchange: 'binance', symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', createdAt: 1000, status: 'active', stoppedAt: null, keepPosition: false, mode: 'paper', params: { side: 'buy', amountQuote: 25, stopLossPct: 1.2, apiKey: 'never' }, ...patch }) as unknown as ExecutorConfig

describe("a paper order's life", () => {
  it('is told once opened, once closed with its result, and once stopped without one; a live order is not a paper trade', () => {
    const opened = position({ lab: { strategy: 'direction', qualified: ['direction'] } as unknown as ExecutorConfig['lab'] })
    expect(originOf(opened)).toBe('lab')
    const first = paperOrderEvents([], [opened], 2000)
    expect(first).toEqual([{ v: 'research-v1', at: 1000, kind: 'opened', id: 'p1', type: 'position', mode: 'paper', exchange: 'binance', symbol: 'SOLUSDT', origin: 'lab', strategy: 'direction', params: { side: 'buy', amountQuote: 25, stopLossPct: 1.2 }, mark: { strategy: 'direction', qualified: ['direction'] } }])
    // Written again unchanged: nothing.
    expect(paperOrderEvents([opened], [opened], 2100)).toEqual([])
    const closed = { ...opened, status: 'stopped' as const, stoppedAt: 3000, lab: { ...opened.lab!, result: { exit: 'take_profit', pnlQuote: 0.31, closedAt: 2990 } } } as unknown as ExecutorConfig
    expect(paperOrderEvents([opened], [closed], 3000)).toEqual([expect.objectContaining({ kind: 'closed', at: 2990, result: { exit: 'take_profit', pnlQuote: 0.31, closedAt: 2990 } })])
    // A close written again: nothing.
    expect(paperOrderEvents([closed], [closed], 3100)).toEqual([])
    // A person's stopped without a result.
    const mine = position({ id: 'p2' })
    expect(paperOrderEvents([mine], [{ ...mine, status: 'stopped', stoppedAt: 4000 }], 4000)).toEqual([expect.objectContaining({ kind: 'stopped', at: 4000, origin: 'person' })])
    expect(paperOrderEvents([], [position({ id: 'live', mode: 'live' })], 5000)).toEqual([])
    expect(originOf(position({ watch: {} as ExecutorConfig['watch'] }))).toBe('watch')
    expect(originOf(position({ forecast: {} as ExecutorConfig['forecast'] }))).toBe('forecast')
  })

  it('carries the mark it was opened under, without its result or a secret, and none on a person\'s own', () => {
    const marked = position({ forecast: { predictionId: 'f1', horizon: 'hours4', side: 'BUY', edgePct: 0.4, token: 'T', result: { exit: 'stop_loss', pnlQuote: -1, closedAt: 9 } } as unknown as ExecutorConfig['forecast'] })
    expect(paperOrderEvents([], [marked], 2000)[0].mark).toEqual({ predictionId: 'f1', horizon: 'hours4', side: 'BUY', edgePct: 0.4 })
    expect(paperOrderEvents([], [position({ id: 'p9' })], 2000)[0]).not.toHaveProperty('mark')
  })

  it("tells the paper account's new ledger entries once", () => {
    const entry = (id: string): { id: string; at: number; asset: string; delta: number; reason: 'allocate'; executorId: string; note: string } => ({ id, at: 1, asset: 'USDT', delta: -25, reason: 'allocate', executorId: 'p1', note: '' })
    expect(paperAccountEvents([entry('a')], [entry('a'), entry('b')])).toEqual([{ v: 'research-v1', ...entry('b') }])
    expect(paperAccountEvents(undefined, [entry('a')])).toHaveLength(1)
    expect(paperAccountEvents([entry('a')], undefined)).toEqual([])
  })
})

describe('the tables', () => {
  it('quote a field holding a comma, a quote or a line break, double a quote, leave null empty and write an object as its JSON', () => {
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
    expect(csvField(0)).toBe('0')
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "no"')).toBe('"say ""no"""')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
    expect(csvField('cr\rhere')).toBe('"cr\rhere"')
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"')
    expect(csvOf(['a', 'b'], [{ a: 1, b: 'x,y' }, { a: null }])).toBe('a,b\r\n1,"x,y"\r\n,\r\n')
    expect(csvOf(['a'], [])).toBe('a\r\n')
  })

  it("join each paper trade's opening to its end, a close after a stop the end, an end without its opening listed as it stands", () => {
    const base = { v: 'research-v1', type: 'position', mode: 'paper', exchange: 'binance', symbol: 'SOLUSDT', origin: 'lab', strategy: 'strict' } as const
    const events: PaperOrderEvent[] = [
      { ...base, id: 'a', at: 1_760_000_000, kind: 'opened', params: { side: 'buy', amountQuote: 25 } },
      { ...base, id: 'b', at: 1_760_000_100, kind: 'opened', params: { side: 'sell' } },
      { ...base, id: 'a', at: 1_760_003_600, kind: 'closed', result: { exit: 'take_profit', pnlQuote: 0.42, closedAt: 1_760_003_600 } },
      { ...base, id: 'c', at: 1_760_004_000, kind: 'stopped' },
      { ...base, id: 'c', at: 1_760_004_100, kind: 'closed', result: { exit: 'time_limit', pnlQuote: -0.1, closedAt: 1_760_004_100 } },
      { ...base, id: 'd', at: 1_760_005_000, kind: 'stopped' },
      { ...base, id: 'd', at: 1_760_005_100, kind: 'stopped' }
    ]
    const rows = paperTradeRows(events)
    expect(rows.map((row) => [row.id, row.end])).toEqual([
      ['a', 'closed'],
      ['b', 'open'],
      ['c', 'closed'],
      ['d', 'stopped']
    ])
    expect(rows[0]).toEqual({ id: 'a', origin: 'lab', strategy: 'strict', mode: 'paper', exchange: 'binance', symbol: 'SOLUSDT', side: 'buy', stakeQuote: 25, openedAt: '2025-10-09T08:53:20Z', endedAt: '2025-10-09T09:53:20Z', end: 'closed', exit: 'take_profit', pnlQuote: 0.42 })
    expect(rows[1]).toMatchObject({ side: 'sell', stakeQuote: null, endedAt: null, exit: null, pnlQuote: null })
    expect(rows[2]).toMatchObject({ openedAt: null, endedAt: '2025-10-09T10:01:40Z', exit: 'time_limit', pnlQuote: -0.1 })
    // The first stop is the end; a second changes nothing.
    expect(rows[3]).toMatchObject({ endedAt: '2025-10-09T10:16:40Z', exit: null })
    const table = csvOf(PAPER_TRADE_COLUMNS, rows as unknown as Record<string, unknown>[]).split('\r\n')
    expect(table[0]).toBe('id,origin,strategy,mode,exchange,symbol,side,stakeQuote,openedAt,endedAt,end,exit,pnlQuote')
    expect(table[1]).toBe('a,lab,strict,paper,binance,SOLUSDT,buy,25,2025-10-09T08:53:20Z,2025-10-09T09:53:20Z,closed,take_profit,0.42')
  })

  it("list an AI request's moment as UTC time", () => {
    const row = { at: 1_760_000_000, source: 'watch', status: 'ok', model: 'm', servedModel: 'm', provider: 'P', usage: { promptTokens: 1, completionTokens: 2, costUsd: 0.5, latencyMs: 3 }, error: null } as unknown as AiCallRecord
    expect(aiRequestCsvRow(aiRequestLine(row))).toMatchObject({ time: '2025-10-09T08:53:20Z', asked: 'm', component: 'watch' })
  })
})

describe("an AI call's line", () => {
  it('says who asked, the model asked and the one that answered, and that no fallback was taken', () => {
    const row = { at: 10, source: 'bot', botId: 'gpt', status: 'ok', model: 'anthropic/claude-opus-5.5', servedModel: 'anthropic/claude-opus-5.5', provider: 'Anthropic', role: 'decide', usage: { promptTokens: 3000, completionTokens: 1200, costUsd: 0.036, latencyMs: 9000 }, error: null } as unknown as AiCallRecord
    expect(aiRequestLine(row)).toEqual({ at: 10, component: 'bot:gpt', role: 'decide', asked: 'anthropic/claude-opus-5.5', served: 'anthropic/claude-opus-5.5', servedMismatch: null, fallback: null, provider: 'Anthropic', status: 'ok', latencyMs: 9000, promptTokens: 3000, completionTokens: 1200, costUsd: 0.036, error: null })
    expect(aiRequestLine({ ...row, source: 'addition', addition: 'daily', botId: undefined } as AiCallRecord).component).toBe('addition:daily')
    expect(aiRequestLine({ ...row, source: 'watch', servedMismatch: 'variant' } as AiCallRecord)).toMatchObject({ component: 'watch', servedMismatch: 'variant' })
  })
})
