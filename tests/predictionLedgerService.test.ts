import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../shared/ipc'
import { SOURCE_RECORD_LINES, SOURCE_RECORD_VERSION, dueAt, sourcePredictionId, type SourcePrediction } from '../shared/evaluation/predictionRecord'

// THE RECORD KEPT AND SETTLED (electron/services/predictionLedgerService.ts; V8 Stage 2): a prediction written as it
// is made, settled once its horizon has passed, read back owed after a restart, and written missing with its reason
// when it is past the look-back or its bars cannot be read -- one outcome a prediction, never two.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const MADE = 1_792_000_040
let dir = ''
let clock = MADE

function prediction(over: Partial<SourcePrediction> = {}): SourcePrediction {
  return {
    v: SOURCE_RECORD_VERSION,
    id: sourcePredictionId('user', 'BTCUSDT', MADE),
    source: 'user',
    sourceVersion: 'user-v1',
    kind: 'direction',
    pair: 'BTCUSDT',
    venue: 'binance',
    madeAt: MADE,
    bar: null,
    horizonSec: 300,
    refPrice: 100,
    side: 'up',
    movePct: 1,
    targetPrice: 101,
    window: null,
    dist: { pRight: null, q: null, pMove: null },
    scenarios: null,
    cost: { roundTripPct: 0.2, basis: 'flat', stakeQuote: 100 },
    expectedNet: null,
    reason: 'my view',
    evidence: [],
    unit: Math.floor(MADE / 86_400),
    versions: { engine: 'e', config: 'c' },
    ...over
  }
}

const barsUp = (from: number, to: number): Candle[] => {
  const out: Candle[] = []
  for (let t = Math.ceil(from / 60) * 60; t < to; t += 60) out.push({ time: t, open: 101, high: 102, low: 100, close: 101.5, volume: 1 })
  return out
}

async function service() {
  const module = await import('../electron/services/predictionLedgerService')
  module.resetPredictionLedger()
  module.predictionLedgerSeam.dir = () => dir
  module.predictionLedgerSeam.now = () => clock
  return module
}

const linesIn = (name: string): unknown[] => {
  try {
    return readFileSync(join(dir, name), 'utf-8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
const month = new Date(MADE * 1000).toISOString().slice(0, 7)

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'predictions-'))
  clock = MADE
})

afterEach(async () => {
  const module = await import('../electron/services/predictionLedgerService')
  module.resetPredictionLedger()
})

describe('a prediction kept and settled', () => {
  it('is written as it is made, owed, and settled once its horizon has passed, once', async () => {
    const ledger = await service()
    const asked: [number, number][] = []
    ledger.predictionLedgerSeam.bars = async (_venue, _pair, from, to) => {
      asked.push([from, to])
      return barsUp(from, to)
    }
    await ledger.recordSourcePrediction(prediction())
    expect(linesIn(`sources-${month}.jsonl`)).toHaveLength(1)
    expect(ledger.owedCount()).toBe(1)
    // Before its due time and its minute after: nothing is asked.
    clock = dueAt(prediction()) + 59
    expect(await ledger.settleOwed()).toBe(0)
    expect(asked).toEqual([])
    clock = dueAt(prediction()) + 60
    const told: string[] = []
    ledger.onSourceOutcome((p, outcome) => told.push(`${p.id}:${outcome.status}:${outcome.right}`))
    expect(await ledger.settleOwed()).toBe(1)
    expect(asked).toEqual([[MADE, dueAt(prediction())]])
    expect(linesIn(`source-outcomes-${month}.jsonl`)).toMatchObject([{ id: prediction().id, status: 'settled', right: true, touched: true }])
    expect(told).toEqual([`${prediction().id}:settled:true`])
    expect(await ledger.settleOwed()).toBe(0)
    expect(ledger.owedCount()).toBe(0)
    await expect(ledger.recordSourcePrediction(prediction())).rejects.toThrow(/is on file already/)
  })

  it('refuses a line it could not read back', async () => {
    const ledger = await service()
    await expect(ledger.recordSourcePrediction({ ...prediction(), horizonSec: 0 })).rejects.toThrow(/not a whole source-record-v1 line/)
    expect(linesIn(`sources-${month}.jsonl`)).toEqual([])
  })

  it('asks again while the bars cannot be read, and writes it missing with the reason six hours past its due time', async () => {
    const ledger = await service()
    ledger.predictionLedgerSeam.bars = async () => {
      throw new Error('the host did not answer')
    }
    await ledger.recordSourcePrediction(prediction())
    clock = dueAt(prediction()) + 3600
    expect(await ledger.settleOwed()).toBe(0)
    expect(ledger.owedCount()).toBe(1)
    clock = dueAt(prediction()) + 6 * 3600
    expect(await ledger.settleOwed()).toBe(1)
    expect(linesIn(`source-outcomes-${month}.jsonl`)).toMatchObject([{ status: 'missing', why: 'its bars could not be read for six hours: the host did not answer' }])
  })

  it('waits for bars that do not yet reach its end, and settles them late when they do', async () => {
    const ledger = await service()
    let reach = MADE + 120
    ledger.predictionLedgerSeam.bars = async (_venue, _pair, from) => barsUp(from, reach)
    await ledger.recordSourcePrediction(prediction())
    clock = dueAt(prediction()) + 60
    expect(await ledger.settleOwed()).toBe(0)
    reach = dueAt(prediction())
    clock = dueAt(prediction()) + SOURCE_RECORD_LINES.graceSec + 120
    expect(await ledger.settleOwed()).toBe(1)
    expect(linesIn(`source-outcomes-${month}.jsonl`)).toMatchObject([{ status: 'late', right: true }])
  })
})

describe('a restart', () => {
  it('reads back what is owed, settles what is already answered never again, and writes missing what is past eight days', async () => {
    mkdirSync(dir, { recursive: true })
    const owed = prediction({ id: 'owed' })
    const answered = prediction({ id: 'answered' })
    const old = prediction({ id: 'old', madeAt: MADE - SOURCE_RECORD_LINES.owedLookbackSec - 60 })
    const oldMonth = new Date(old.madeAt * 1000).toISOString().slice(0, 7)
    writeFileSync(join(dir, `sources-${month}.jsonl`), [owed, answered].map((p) => JSON.stringify(p)).join('\n') + '\n')
    if (oldMonth !== month) writeFileSync(join(dir, `sources-${oldMonth}.jsonl`), JSON.stringify(old) + '\n')
    else writeFileSync(join(dir, `sources-${month}.jsonl`), [owed, answered, old].map((p) => JSON.stringify(p)).join('\n') + '\n')
    writeFileSync(join(dir, `source-outcomes-${month}.jsonl`), JSON.stringify({ v: SOURCE_RECORD_VERSION, id: 'answered', at: MADE + 400, status: 'settled', closePrice: 101, movePct: 1, bestPct: 1, worstPct: 0, right: true, sizeErrorPct: 0, touched: true, touchSec: 60, netPct: 0.8 }) + '\n')
    clock = MADE + 10
    const ledger = await service()
    ledger.predictionLedgerSeam.bars = async (_venue, _pair, from, to) => barsUp(from, to)
    await ledger.startPredictionLedger()
    expect(ledger.owedCount()).toBe(1)
    const record = await ledger.sourceRecord()
    expect(record.find((entry) => entry.prediction.id === 'old')!.outcome).toMatchObject({ status: 'missing', why: 'the app was not running to settle it within eight days of its making' })
    expect(record.find((entry) => entry.prediction.id === 'answered')!.outcome).toMatchObject({ status: 'settled' })
    clock = dueAt(owed) + 60
    expect(await ledger.settleOwed()).toBe(1)
    const outcomes = (await ledger.sourceRecord()).map((entry) => entry.outcome?.id ?? null)
    expect(outcomes.sort()).toEqual(['answered', 'old', 'owed'])
    expect(await ledger.sourceRecord({ source: 'trader' })).toEqual([])
  })
})
