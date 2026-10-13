import type { ForestModel } from './forest'
import type { GbtModel } from './gbt'
import type { RidgeModel } from './ridge'
import type { FlatTree } from './tree'

// A MODEL ON FILE (V6 Stage 4, 13 October 2026): one line of JSON with every object's keys in order,
// so that the same model is the same bytes and its content hash names it. Read back, it is checked
// shape by shape, and anything else is refused rather than half-read.

export type MlModel = GbtModel | ForestModel | RidgeModel

/** JSON with every object's keys sorted. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('a model holds a number that is not finite')
  return JSON.stringify(value) ?? 'null'
}

export function serializeModel(model: MlModel): string {
  return canonicalJson(model)
}

const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))

function isTree(value: unknown): value is FlatTree {
  const tree = value as Partial<Record<keyof FlatTree, unknown>> | null
  if (typeof tree !== 'object' || tree === null) return false
  const keys: (keyof FlatTree)[] = ['feature', 'threshold', 'bin', 'left', 'right', 'value', 'cover', 'gain']
  if (!keys.every((key) => numbers(tree[key]))) return false
  const length = (tree.feature as number[]).length
  return length > 0 && keys.every((key) => (tree[key] as number[]).length === length)
}

/** A model read back from its line; null for anything that is not one. */
export function parseModel(text: string): MlModel | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const model = raw as Record<string, unknown> | null
  if (typeof model !== 'object' || model === null) return null
  if (model.kind === 'gbt') {
    const loss = model.loss as { kind?: unknown; tau?: unknown } | null
    const lossOk = loss !== null && typeof loss === 'object' && (loss.kind === 'l2' || (loss.kind === 'pinball' && typeof loss.tau === 'number' && loss.tau > 0 && loss.tau < 1))
    if (!lossOk || typeof model.base !== 'number' || typeof model.features !== 'number' || typeof model.grown !== 'number' || !Array.isArray(model.trees) || !model.trees.every(isTree)) return null
    return model as unknown as GbtModel
  }
  if (model.kind === 'forest') {
    if (typeof model.features !== 'number' || !Array.isArray(model.trees) || !model.trees.every(isTree)) return null
    return model as unknown as ForestModel
  }
  if (model.kind === 'ridge') {
    if (!numbers(model.mean) || !numbers(model.scale) || !numbers(model.coef) || !numbers(model.columns) || typeof model.intercept !== 'number') return null
    const d = (model.columns as number[]).length
    if ((model.mean as number[]).length !== d || (model.scale as number[]).length !== d || (model.coef as number[]).length !== d) return null
    return model as unknown as RidgeModel
  }
  return null
}
