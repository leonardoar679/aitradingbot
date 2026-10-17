import type { PairedHorizon } from './challenger'
import { FEATURE_COUNT, FEATURE_NAMES, HORIZONS, MARKET_REGIMES, PAIR_CLASSES, type FeatureName, type Horizon } from './features'
import type { Panel } from './panel'

// FEATURE BLOCKS, AND A FIT WITHOUT ONE (V7.2 Stage 4, 17 October 2026). The rows' sixty-three figures fall
// in named blocks -- the price's moves and usual sizes, the technical figures, the volume and who pressed
// it, the indicators, the market and Bitcoin, the market's last fifteen minutes, the regime, the pair's
// class, the clock -- and the worth of a block is read by fitting the walk forward twice on identical folds
// and seeds, once with every block and once with the block's columns held at their training mean (a
// constant column carries nothing: the trees cannot split on it, the lines read it as an intercept), and
// pairing the two forecasts row by row (research/ablation.ts). The mask is on the rows the models are
// handed, never on the models: the engine's fit is unchanged, and a block left out of a research fit never
// reaches a model file. Arithmetic on the panel: no key, no order.

export const ABLATION_VERSION = 'ablation-v1'
export const FEATURE_BLOCKS = ['price', 'tech', 'volume', 'indicators', 'market', 'fifteen', 'regime', 'class', 'clock'] as const
export type FeatureBlock = (typeof FEATURE_BLOCKS)[number]

/** What research/ablation.ts writes into a profile's forecastModels/ablation-<horizon>-<block>.json: the full fit
 * paired with the fit without the block (the difference being without less with: a positive pinball difference
 * means the block helped), and the control with the block permuted; null where a pair could not be read. */
export interface AblationFile {
  version: string
  horizon: Horizon
  block: FeatureBlock
  madeAt: number
  rows: number
  paired: PairedHorizon | null
  control: PairedHorizon | null
  seconds: number
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function readPaired(value: unknown): PairedHorizon | null | undefined {
  if (value === null) return null
  if (!isObject(value) || !finite(value.hours) || !finite(value.blocks)) return undefined
  const figure = (raw: unknown): PairedHorizon['pinball'] | undefined => {
    if (!isObject(raw) || !finite(raw.difference) || !finite(raw.low) || !finite(raw.high) || typeof raw.better !== 'boolean' || typeof raw.worse !== 'boolean') return undefined
    return { difference: raw.difference, low: raw.low, high: raw.high, better: raw.better, worse: raw.worse }
  }
  const pinball = figure(value.pinball)
  const coverageDistance = figure(value.coverageDistance)
  const directionSkill = value.directionSkill === null ? null : figure(value.directionSkill)
  if (pinball === undefined || coverageDistance === undefined || directionSkill === undefined) return undefined
  return { hours: value.hours, blocks: value.blocks, pinball, coverageDistance, directionSkill }
}

/** An ablation file read back; null for one of another version or no shape of one. */
export function parseAblationFile(text: string): AblationFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || raw.version !== ABLATION_VERSION || !HORIZONS.includes(raw.horizon as Horizon) || !FEATURE_BLOCKS.includes(raw.block as FeatureBlock) || !finite(raw.madeAt) || !finite(raw.rows) || !finite(raw.seconds)) return null
  const paired = readPaired(raw.paired)
  const control = readPaired(raw.control)
  if (paired === undefined || control === undefined) return null
  return { version: ABLATION_VERSION, horizon: raw.horizon as Horizon, block: raw.block as FeatureBlock, madeAt: raw.madeAt, rows: raw.rows, paired, control, seconds: raw.seconds }
}

const at = (name: FeatureName): number => FEATURE_NAMES.indexOf(name)

/** Each block's columns: the figures from its first name to the next block's first, in the rows' order. */
export const BLOCK_COLUMNS: Readonly<Record<FeatureBlock, readonly number[]>> = ((): Record<FeatureBlock, number[]> => {
  const starts: [FeatureBlock, number][] = [
    ['price', 0],
    ['tech', at('acc_15m')],
    ['volume', at('vol_ratio_1h')],
    ['indicators', at('ema20_1h')],
    ['market', at('btc_r_1h')],
    ['fifteen', at('btc_r_15m')],
    ['regime', at(`regime_${MARKET_REGIMES[0]}` as FeatureName)],
    ['class', at(`class_${PAIR_CLASSES[0]}` as FeatureName)],
    ['clock', at('hour_sin')]
  ]
  const out = {} as Record<FeatureBlock, number[]>
  for (const [index, [block, start]] of starts.entries()) {
    const end = index + 1 < starts.length ? starts[index + 1][1] : FEATURE_COUNT
    out[block] = Array.from({ length: end - start }, (_, k) => start + k)
  }
  return out
})()

/** The block a column belongs to. */
export function blockOf(column: number): FeatureBlock | null {
  for (const block of FEATURE_BLOCKS) if (BLOCK_COLUMNS[block].includes(column)) return block
  return null
}

/** The panel's figures with the columns of every block NOT kept held at their mean over `trainRows`, in a
 * copy; the panel itself untouched. */
export function maskBlocks(panel: Panel, keep: readonly FeatureBlock[], trainRows: Uint32Array): Panel {
  const masked = FEATURE_BLOCKS.filter((block) => !keep.includes(block)).flatMap((block) => BLOCK_COLUMNS[block])
  if (masked.length === 0) return panel
  const means = new Float64Array(masked.length)
  for (const row of trainRows) for (const [k, column] of masked.entries()) means[k] += panel.x[row * panel.cols + column]
  for (let k = 0; k < means.length; k++) means[k] = trainRows.length > 0 ? means[k] / trainRows.length : 0
  const x = Float32Array.from(panel.x)
  for (let row = 0; row < panel.rows; row++) for (const [k, column] of masked.entries()) x[row * panel.cols + column] = means[k]
  return { ...panel, x }
}

/** The same panel with one block's columns permuted across the rows given (the same permutation for every
 * column of the block, by a seeded shuffle), the control a block's worth is set against. */
export function permuteBlock(panel: Panel, block: FeatureBlock, rows: Uint32Array, random: () => number): Panel {
  const order = Array.from(rows)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const swap = order[i]
    order[i] = order[j]
    order[j] = swap
  }
  const x = Float32Array.from(panel.x)
  for (const column of BLOCK_COLUMNS[block]) for (const [k, row] of Array.from(rows).entries()) x[row * panel.cols + column] = panel.x[order[k] * panel.cols + column]
  return { ...panel, x }
}
