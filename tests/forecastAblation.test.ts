import { describe, expect, it } from 'vitest'
import { ABLATION_VERSION, BLOCK_COLUMNS, FEATURE_BLOCKS, blockOf, maskBlocks, parseAblationFile, permuteBlock, type AblationFile } from '../shared/forecast/ablation'
import { FEATURE_COUNT, FEATURE_NAMES } from '../shared/forecast/features'
import type { Panel } from '../shared/forecast/panel'
import { rng } from './forecastRecords'

// FEATURE BLOCKS, AND A FIT WITHOUT ONE (shared/forecast/ablation.ts; V7.2 Stage 4): the blocks cover every
// column once, in the rows' order; a block held at its training mean in a copy, the panel untouched; a block
// permuted across rows for the control.

function panelOf(rows: number): Panel {
  const cols = FEATURE_COUNT
  const x = Float32Array.from({ length: rows * cols }, (_, at) => (at % cols) * 100 + Math.floor(at / cols))
  const empty = (): Float32Array => new Float32Array(rows)
  return {
    rows,
    cols,
    x,
    time: Uint32Array.from({ length: rows }, (_, row) => row * 900),
    pair: new Uint16Array(rows),
    cls: new Uint8Array(rows),
    regime: new Uint8Array(rows),
    rv24h: new Float32Array(rows).fill(0.03),
    y: { minutes5: empty(), minutes15: empty(), hour1: empty(), hours4: empty(), hours24: empty() },
    best: { minutes5: empty(), minutes15: empty(), hour1: empty(), hours4: empty(), hours24: empty() },
    worst: { minutes5: empty(), minutes15: empty(), hour1: empty(), hours4: empty(), hours24: empty() },
    symbols: ['BTCUSDT']
  }
}

describe('the blocks', () => {
  it('cover every column once, in order, each block from its first name', () => {
    const all = FEATURE_BLOCKS.flatMap((block) => BLOCK_COLUMNS[block])
    expect(all).toEqual(Array.from({ length: FEATURE_COUNT }, (_, k) => k))
    expect(BLOCK_COLUMNS.price[0]).toBe(0)
    expect(FEATURE_NAMES[BLOCK_COLUMNS.tech[0]]).toBe('acc_15m')
    expect(FEATURE_NAMES[BLOCK_COLUMNS.volume[0]]).toBe('vol_ratio_1h')
    expect(FEATURE_NAMES[BLOCK_COLUMNS.indicators[0]]).toBe('ema20_1h')
    expect(FEATURE_NAMES[BLOCK_COLUMNS.market[0]]).toBe('btc_r_1h')
    expect(FEATURE_NAMES[BLOCK_COLUMNS.fifteen[0]]).toBe('btc_r_15m')
    expect(FEATURE_NAMES[BLOCK_COLUMNS.regime[0]]).toBe('regime_panic')
    expect(FEATURE_NAMES[BLOCK_COLUMNS.class[0]]).toBe('class_btc')
    expect(BLOCK_COLUMNS.clock.map((column) => FEATURE_NAMES[column])).toEqual(['hour_sin', 'hour_cos', 'dow_sin', 'dow_cos'])
    expect(blockOf(0)).toBe('price')
    expect(blockOf(FEATURE_COUNT - 1)).toBe('clock')
    expect(blockOf(FEATURE_COUNT)).toBeNull()
  })

  it('holds the blocks not kept at their training mean in a copy, the panel untouched', () => {
    const panel = panelOf(10)
    const before = Float32Array.from(panel.x)
    const train = Uint32Array.from([0, 1, 2, 3])
    const masked = maskBlocks(panel, FEATURE_BLOCKS.filter((block) => block !== 'clock'), train)
    expect(panel.x).toEqual(before)
    expect(masked).not.toBe(panel)
    expect(masked.rows).toBe(10)
    for (const column of BLOCK_COLUMNS.clock) {
      // The mean over rows 0-3 of column c: c x 100 + 1.5.
      for (let row = 0; row < 10; row++) expect(masked.x[row * panel.cols + column]).toBeCloseTo(column * 100 + 1.5, 4)
    }
    for (const column of BLOCK_COLUMNS.price) for (let row = 0; row < 10; row++) expect(masked.x[row * panel.cols + column]).toBe(panel.x[row * panel.cols + column])
    // Every block kept: the panel itself.
    expect(maskBlocks(panel, [...FEATURE_BLOCKS], train)).toBe(panel)
    // No training row: zero.
    expect(maskBlocks(panel, [], new Uint32Array()).x[BLOCK_COLUMNS.clock[0]]).toBe(0)
  })

  it('permutes one block across the rows given, the same permutation for every column of the block, and nothing else', () => {
    const panel = panelOf(12)
    const rows = Uint32Array.from([2, 3, 4, 5, 6, 7, 8, 9])
    const permuted = permuteBlock(panel, 'market', rows, rng(5))
    expect(permuted).not.toBe(panel)
    const column = (made: Panel, c: number): number[] => Array.from(rows, (row) => made.x[row * made.cols + c])
    const [first, second] = BLOCK_COLUMNS.market
    expect(column(permuted, first).sort((a, b) => a - b)).toEqual(column(panel, first).sort((a, b) => a - b))
    expect(column(permuted, first)).not.toEqual(column(panel, first))
    // The same order for every column of the block: the second column follows the first row for row.
    expect(column(permuted, second).map((value) => value - 100)).toEqual(column(permuted, first))
    // Rows outside, and other blocks, untouched.
    for (const row of [0, 1, 10, 11]) for (const c of BLOCK_COLUMNS.market) expect(permuted.x[row * panel.cols + c]).toBe(panel.x[row * panel.cols + c])
    for (const c of BLOCK_COLUMNS.price) expect(column(permuted, c)).toEqual(column(panel, c))
    // The same seed, the same permutation.
    expect(permuteBlock(panel, 'market', rows, rng(5)).x).toEqual(permuted.x)
  })
})

describe('the file', () => {
  it('reads an ablation file back whole, its control too, and refuses another version or a part-made figure', () => {
    const figure = { difference: -0.002, low: -0.003, high: -0.001, better: true, worse: false }
    const file: AblationFile = { version: ABLATION_VERSION, horizon: 'hour1', block: 'clock', madeAt: 1_792_000_000, rows: 500, paired: { hours: 100, blocks: 100, pinball: figure, coverageDistance: { ...figure, better: false }, directionSkill: null }, control: { hours: 100, blocks: 100, pinball: { ...figure, difference: 0.0001, better: false }, coverageDistance: figure, directionSkill: figure }, seconds: 60 }
    expect(parseAblationFile(JSON.stringify(file))).toEqual(file)
    expect(parseAblationFile(JSON.stringify({ ...file, paired: null, control: null }))).toEqual({ ...file, paired: null, control: null })
    expect(parseAblationFile(JSON.stringify({ ...file, version: 'ablation-v0' }))).toBeNull()
    expect(parseAblationFile(JSON.stringify({ ...file, block: 'weather' }))).toBeNull()
    expect(parseAblationFile(JSON.stringify({ ...file, control: { hours: 'x' } }))).toBeNull()
    expect(parseAblationFile(JSON.stringify({ ...file, paired: { ...file.paired, pinball: { difference: 1 } } }))).toBeNull()
    expect(parseAblationFile('{not json')).toBeNull()
  })
})
