import { describe, it, expect } from 'vitest'
import { executorTypeMeta } from '../src/executors/executorTypeMeta'
import type { ExecutorType } from '../shared/ipc'

const ALL_TYPES: ExecutorType[] = [
  'grid',
  'dca',
  'twap',
  'position',
  'order',
  'xemm',
  'arbitrage',
  'marketmaking'
]

describe('executorTypeMeta', () => {
  it('gives every real executor type its own label, icon and colour', () => {
    for (const type of ALL_TYPES) {
      const meta = executorTypeMeta(type)
      expect(meta.icon, `${type} icon`).toBeDefined()
      expect(meta.label, `${type} label`).not.toContain('Unknown')
      expect(meta.color, `${type} colour`).toMatch(/^#/)
    }
  })

  it('gives each type a distinct label', () => {
    const labels = ALL_TYPES.map((t) => executorTypeMeta(t).label)
    expect(new Set(labels).size).toBe(ALL_TYPES.length)
  })

  it('keeps the exact labels the cards used before the lookup moved out of ExecutorCard', () => {
    expect(executorTypeMeta('grid').label).toBe('Grid')
    expect(executorTypeMeta('dca').label).toBe('DCA')
    expect(executorTypeMeta('twap').label).toBe('TWAP')
    expect(executorTypeMeta('position').label).toBe('Position')
    expect(executorTypeMeta('order').label).toBe('Order')
    expect(executorTypeMeta('xemm').label).toBe('XEMM')
    expect(executorTypeMeta('arbitrage').label).toBe('Arbitrage')
    expect(executorTypeMeta('marketmaking').label).toBe('Market Making')
  })

  // The actual crash: `TYPE_META[type].icon` on a type string that isn't in the union threw
  // "Cannot read properties of undefined (reading 'icon')" during render, which unmounted the
  // whole React tree and blanked the window.
  it('returns a usable icon for a type string that is not in the union', () => {
    const meta = executorTypeMeta('marketMaking')
    expect(meta.icon).toBeDefined()
    expect(meta.color).toBeTruthy()
  })

  it('names the unrecognised type so it can be reported', () => {
    expect(executorTypeMeta('marketMaking').label).toBe('Unknown (marketMaking)')
    expect(executorTypeMeta('somethingNew').label).toBe('Unknown (somethingNew)')
  })

  it('never returns undefined, whatever string it is handed', () => {
    for (const weird of ['', ' ', 'GRID', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const meta = executorTypeMeta(weird)
      expect(meta, `type ${JSON.stringify(weird)}`).toBeDefined()
      expect(meta.icon, `type ${JSON.stringify(weird)} icon`).toBeDefined()
      expect(typeof meta.label, `type ${JSON.stringify(weird)} label`).toBe('string')
    }
  })

  it('is not fooled by inherited Object properties', () => {
    // A plain object literal inherits toString/constructor, so `TYPE_META['toString']` is truthy
    // and `?? fallback` would not fire -- the icon would still be undefined and still crash.
    expect(executorTypeMeta('toString').label).toBe('Unknown (toString)')
    expect(executorTypeMeta('constructor').label).toBe('Unknown (constructor)')
  })
})
