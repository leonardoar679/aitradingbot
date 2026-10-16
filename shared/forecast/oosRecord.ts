import { HORIZONS, type Horizon } from './features'
import { QUANTILE_LEVELS } from './ml/quantile'
import { DIRECTION_MODELS, FORECAST_MODELS, type DirectionModelId, type ForecastModelId } from './models'

// THE OUT-OF-SAMPLE RECORD (the V6 document, §26-27, §51-52 and §95; V6 Stage 5, 13 October 2026):
// what every model forecast for every hour of the weeks the walk forward tested it on, beside what
// happened, kept for the calibration (V6 Stage 6), the Lab and its replay (V6 Stage 11). An hour a
// row: a month of thirty-seven pairs is about 25,000 rows a horizon.
//
// IN COLUMNS, NOT JSON. Thirty-five numbers a row (seven models, five quantiles) as text would be ten
// times the size: forecastModels/<run>/oos-<horizon>.bin is a header -- a JSON line saying what the
// columns are -- and the columns after it, each a typed array.
//
// forecast-oos-v2 (V6.1, 15 October 2026) adds Bitcoin's last fifteen minutes at each row's moment, in its
// usual moves, for the calibration's rule on Bitcoin's sharp moves (shared/forecast/shock.ts). A v1 record
// still reads, without it: no rule is fitted from it until the next refit writes a v2.
//
// forecast-oos-v3 (V7.1 Stage 2, 16 October 2026) adds each direction model's raw chance of up at each row
// (shared/forecast/models.ts, predictDirection), for the calibration to map and judge. A v1 or v2 record
// still reads, without them: no direction model is judged from it until the next refit writes a v3.

export const OOS_VERSION = 'forecast-oos-v3'
const OOS_V2 = 'forecast-oos-v2'
const OOS_V1 = 'forecast-oos-v1'

export interface OosRecord {
  version: string
  horizon: Horizon
  symbols: string[]
  models: readonly ForecastModelId[]
  rows: number
  time: Uint32Array
  pair: Uint16Array
  cls: Uint8Array
  regime: Uint8Array
  fold: Uint8Array
  /** The outcome in units of the usual move, and the usual move's base (the day's volatility). */
  z: Float32Array
  rv24h: Float32Array
  /** The outcome in log return, and the path's best and worst. */
  y: Float32Array
  best: Float32Array
  worst: Float32Array
  /** rows x models x five quantiles of z. */
  quantiles: Float32Array
  /** Bitcoin's last fifteen minutes at the row's moment, in its usual moves (its own z_15m figure);
   * NaN where Bitcoin had no row then. Absent on a v1 record. */
  btc15?: Float32Array
  /** The direction models the record holds readings of, and rows x those models' raw chances of up
   * (V7.1 Stage 2). Absent on a record from before them. */
  directionModels?: readonly DirectionModelId[]
  direction?: Float32Array
}

type Column = 'time' | 'pair' | 'cls' | 'regime' | 'fold' | 'z' | 'rv24h' | 'y' | 'best' | 'worst' | 'quantiles' | 'btc15' | 'direction'
interface Shape {
  models: readonly unknown[]
  directionModels: readonly unknown[]
}
type ColumnSpec = { name: Column; type: 'u32' | 'u16' | 'u8' | 'f32'; width: (shape: Shape) => number }
const COLUMNS_V1: ColumnSpec[] = [
  { name: 'time', type: 'u32', width: () => 1 },
  { name: 'pair', type: 'u16', width: () => 1 },
  { name: 'cls', type: 'u8', width: () => 1 },
  { name: 'regime', type: 'u8', width: () => 1 },
  { name: 'fold', type: 'u8', width: () => 1 },
  { name: 'z', type: 'f32', width: () => 1 },
  { name: 'rv24h', type: 'f32', width: () => 1 },
  { name: 'y', type: 'f32', width: () => 1 },
  { name: 'best', type: 'f32', width: () => 1 },
  { name: 'worst', type: 'f32', width: () => 1 },
  { name: 'quantiles', type: 'f32', width: (shape) => shape.models.length * QUANTILE_LEVELS.length }
]
const COLUMNS_V2: ColumnSpec[] = [...COLUMNS_V1, { name: 'btc15', type: 'f32', width: () => 1 }]
const COLUMNS: ColumnSpec[] = [...COLUMNS_V2, { name: 'direction', type: 'f32', width: (shape) => shape.directionModels.length }]
const BYTES = { u32: 4, u16: 2, u8: 1, f32: 4 } as const
const align = (offset: number): number => Math.ceil(offset / 8) * 8

export function encodeOos(record: OosRecord): Uint8Array {
  const directionModels = record.directionModels ?? []
  const shape: Shape = { models: record.models, directionModels }
  const header = new TextEncoder().encode(JSON.stringify({ version: OOS_VERSION, horizon: record.horizon, symbols: record.symbols, models: record.models, directionModels, rows: record.rows }))
  let offset = align(4 + header.length)
  const placed = COLUMNS.map((column) => {
    const at = offset
    offset = align(offset + record.rows * column.width(shape) * BYTES[column.type])
    return { column, at }
  })
  const bytes = new Uint8Array(offset)
  new DataView(bytes.buffer).setUint32(0, header.length, true)
  bytes.set(header, 4)
  for (const { column, at } of placed) {
    const length = record.rows * column.width(shape)
    const values = column.name === 'btc15' ? (record.btc15 ?? new Float32Array(record.rows).fill(Number.NaN)) : column.name === 'direction' ? (record.direction ?? new Float32Array(length).fill(Number.NaN)) : record[column.name]
    bytes.set(new Uint8Array(values.buffer, values.byteOffset, length * BYTES[column.type]), at)
  }
  return bytes
}

/** A record read back; null for bytes that are not one. The columns are copies, aligned. */
export function decodeOos(bytes: Uint8Array): OosRecord | null {
  if (bytes.length < 4) return null
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(0, true)
  if (4 + headerLength > bytes.length) return null
  let header: { version?: unknown; horizon?: unknown; symbols?: unknown; models?: unknown; directionModels?: unknown; rows?: unknown }
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)))
  } catch {
    return null
  }
  const models = header.models
  const columns = header.version === OOS_VERSION ? COLUMNS : header.version === OOS_V2 ? COLUMNS_V2 : header.version === OOS_V1 ? COLUMNS_V1 : null
  const directionModels = header.version === OOS_VERSION ? header.directionModels : []
  if (
    columns === null ||
    !HORIZONS.includes(header.horizon as Horizon) ||
    !Array.isArray(header.symbols) ||
    !Array.isArray(models) ||
    !models.every((model) => (FORECAST_MODELS as readonly string[]).includes(model as string)) ||
    !Array.isArray(directionModels) ||
    !directionModels.every((model) => (DIRECTION_MODELS as readonly string[]).includes(model as string)) ||
    typeof header.rows !== 'number' ||
    !Number.isInteger(header.rows) ||
    header.rows < 0
  ) return null
  const rows = header.rows
  const shape: Shape = { models: models as ForecastModelId[], directionModels: directionModels as DirectionModelId[] }
  let offset = align(4 + headerLength)
  const out: Partial<Record<Column, Uint32Array | Uint16Array | Uint8Array | Float32Array>> = {}
  for (const column of columns) {
    const length = rows * column.width(shape)
    const byteLength = length * BYTES[column.type]
    if (offset + byteLength > bytes.length) return null
    const slice = bytes.slice(offset, offset + byteLength)
    out[column.name] = column.type === 'u32' ? new Uint32Array(slice.buffer) : column.type === 'u16' ? new Uint16Array(slice.buffer) : column.type === 'u8' ? new Uint8Array(slice.buffer) : new Float32Array(slice.buffer)
    offset = align(offset + byteLength)
  }
  return {
    version: header.version as string,
    horizon: header.horizon as Horizon,
    symbols: header.symbols as string[],
    models: shape.models as ForecastModelId[],
    rows,
    time: out.time as Uint32Array,
    pair: out.pair as Uint16Array,
    cls: out.cls as Uint8Array,
    regime: out.regime as Uint8Array,
    fold: out.fold as Uint8Array,
    z: out.z as Float32Array,
    rv24h: out.rv24h as Float32Array,
    y: out.y as Float32Array,
    best: out.best as Float32Array,
    worst: out.worst as Float32Array,
    quantiles: out.quantiles as Float32Array,
    ...(out.btc15 === undefined ? {} : { btc15: out.btc15 as Float32Array }),
    ...(out.direction === undefined || shape.directionModels.length === 0 ? {} : { directionModels: shape.directionModels as DirectionModelId[], direction: out.direction as Float32Array })
  }
}

/** One row's five quantiles of z for one model. */
export function oosQuantiles(record: OosRecord, row: number, model: ForecastModelId): number[] {
  const index = record.models.indexOf(model)
  const base = (row * record.models.length + index) * QUANTILE_LEVELS.length
  return Array.from(record.quantiles.subarray(base, base + QUANTILE_LEVELS.length))
}

/** One row's raw chance of up by one direction model; undefined where the record holds none. */
export function oosDirection(record: OosRecord, row: number, model: DirectionModelId): number | undefined {
  const index = record.directionModels?.indexOf(model) ?? -1
  if (index < 0 || record.direction === undefined) return undefined
  const value = record.direction[row * record.directionModels!.length + index]
  return Number.isFinite(value) ? value : undefined
}
