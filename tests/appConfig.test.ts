import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ENGINE_CONSTANTS, defaultStores, effectiveConfig, flattenConfig, healStores, stableJson, type EffectiveStores } from '../shared/appConfig'
import { DEFAULT_ENABLED_MODELS } from '../shared/aiSignal'
import { DEFAULT_AI_WATCH } from '../shared/aiWatch'
import { EVENT_DETECTOR_VERSION } from '../shared/marketEvent'

// THE EFFECTIVE CONFIGURATION AND ITS VERSIONS (shared/appConfig.ts; the V4 document, §4-5 and §61).
// The engine version hashes the constants alone and is pinned here, so a constant changes only on
// purpose; the configuration version hashes the stores with them, so two profiles, or one profile
// before and after a setting, are told apart.

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Today's engine, as hashed. A change to any pinned constant moves it: change it here on purpose. */
// 8 October 2026: the fifth AI addition (its limit, prompt and schema) moved it from 60c026073c92;
// later that day the hard limits and the settings files' version (V5 Stage 1) moved it from 9f6c8af7757e,
// and the event's life, fingerprint and cause (V5 Stage 4) from fdf553c8b5bb; the conditions' risk lines
// (V5 Stage 7) from 0f3c4a0f6b6c, and the records' retention (V5 Stage 12) from 7e9adb65bce8. 13 October
// 2026: the price forecast's constants -- its bars, figures, models, training, walk forward, promotion and
// degradation lines (V6 Stage 5) -- moved it from 3bd9a23b9d16, and its ensemble, calibration, direction,
// reliability and prediction lines (V6 Stage 6) from 9bdf452dfbad, and its refresh, outcome and record
// lines (V6 Stage 7, set on it late, here) and its news lines and the feed's kinds (V6 Stage 8) from
// ca5f8f97fce7; its quality, edge, ranking and trade-decision lines (V6 Stage 9) from 23ced32587e9; the
// PREDICTION CHANGED lines and the degraded model's daily thread (V6 Stage 10) from 6b0724f0b3e7; the
// Forecast Lab's lines (V6 Stage 11) from 26f5ec2cd7fe; the trade plan's and the opportunity classes'
// lines and the decision's class (V6 Stage 12) from d4f993254490; the four sounds' scores and the top
// prediction's chime (V6 Stage 13) from b1d829b1f829; the rule on Bitcoin's sharp moves, its record and
// the prediction's version (V6.1) from 9fbd5ea2297a. 16 October 2026: the direction models -- their list,
// training budget and floor, their checklist's lines, the logistic fit's, the models', calibration's and
// prediction's versions (V7.1 Stage 2) -- from d2b9e695247f; the path's figures -- the excursion levels and
// their calibration's lines, the first-touch table's levels, windows and lines, the models', record's,
// calibration's and prediction's versions (V7.1 Stage 3) -- from 847feb643cef.
const PINNED_ENGINE_VERSION = '6e0cea776232'

describe('the engine version', () => {
  it('is the first twelve characters of the hash of the constants, in a fixed key order', () => {
    const config = effectiveConfig(defaultStores(), sha256)
    expect(config.engineVersion).toMatch(/^[0-9a-f]{12}$/)
    expect(config.engineVersion).toBe(sha256(stableJson(ENGINE_CONSTANTS)).slice(0, 12))
    expect(config.engine).toBe(ENGINE_CONSTANTS)
    expect(ENGINE_CONSTANTS.marketEvent.detector).toBe(EVENT_DETECTOR_VERSION)
  })

  it('is today\'s, pinned', () => {
    expect(effectiveConfig(defaultStores(), sha256).engineVersion).toBe(PINNED_ENGINE_VERSION)
  })
})

describe('the configuration version', () => {
  it('is the same for the same stores, and another for a setting changed', () => {
    const a = effectiveConfig(defaultStores(), sha256)
    const b = effectiveConfig(defaultStores(), sha256)
    expect(a.configVersion).toBe(b.configVersion)
    expect(a.configVersion).not.toBe(a.engineVersion)
    const changed: EffectiveStores = { ...defaultStores(), scanner: { enabled: true, universeSize: 100 } }
    expect(effectiveConfig(changed, sha256).configVersion).not.toBe(a.configVersion)
    expect(effectiveConfig(changed, sha256).engineVersion).toBe(a.engineVersion)
  })

  it('does not depend on the order keys were written in', () => {
    expect(stableJson({ b: 1, a: { d: [2, { f: 1, e: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"e":2,"f":1}]},"b":1}')
  })
})

describe('the stores, healed', () => {
  it('reads an empty profile as the defaults', () => {
    const live = { maxOrderQuote: 10, hardMaxOrderQuote: 25, dailyCapQuote: 50, dailyLossLimitQuote: 15, allocationQuote: null, riskPct: 0.25 }
    const healed = healStores({
      settings: {},
      // A fresh install enables the default three (8 October 2026), which the watch is then offered.
      ai: { defaultModel: 'openai/gpt-5-mini', enabledModels: [...DEFAULT_ENABLED_MODELS], dailyCapUsd: 1, callsPerMinute: 30, watch: undefined, watchPaper: undefined, additions: undefined },
      scanner: { enabled: true, universeSize: 60 },
      news: undefined,
      live
    })
    expect(healed).toEqual({ ...defaultStores(), live })
  })

  it('keeps what a profile set, and sorts the models so the order they were enabled in does not count', () => {
    const live = { maxOrderQuote: 10, hardMaxOrderQuote: 25, dailyCapQuote: 50, dailyLossLimitQuote: 15, allocationQuote: 200, riskPct: 0.25 }
    const healed = healStores({
      settings: { paperRisk: { sizing: 'risk', riskQuote: 2, riskPct: 0.25, maxOutQuote: 500 }, alerts: { enabled: false }, keepRunningWhenClosed: true, uiMode: 'expert' },
      ai: { defaultModel: 'openai/gpt-5-mini', enabledModels: ['z/model', 'a/model', 'openai/gpt-5-mini'], dailyCapUsd: 5, callsPerMinute: 60, watch: { ...DEFAULT_AI_WATCH, enabled: true, models: ['openai/gpt-5-mini'] }, watchPaper: undefined, additions: undefined },
      scanner: { enabled: true, universeSize: 40 },
      news: undefined,
      live
    })
    // A profile written before the correlated share was a setting (V6 Stage 12) reads the 0.15 it was.
    expect(healed.paperRisk).toEqual({ sizing: 'risk', riskQuote: 2, riskPct: 0.25, maxOutQuote: 500, correlatedShare: 0.15 })
    expect(healed.alerts).toEqual({ enabled: false, sound: true, desktop: true })
    expect(healed.sounds).toEqual({ volume: 0.7, mutedKinds: [], cooldownSec: 30, quietHours: null })
    expect(healed.app).toEqual({ keepRunningWhenClosed: true, uiMode: 'expert', language: null })
    expect(healed.ai).toEqual({ defaultModel: 'openai/gpt-5-mini', enabledModels: ['a/model', 'openai/gpt-5-mini', 'z/model'], dailyCapUsd: 5, callsPerMinute: 60 })
    expect(healed.watch.enabled).toBe(true)
    expect(healed.scanner).toEqual({ enabled: true, universeSize: 40 })
    expect(healed.live.allocationQuote).toBe(200)
  })
})

describe('the rows a card shows', () => {
  it('flattens every value to its path, lists arrays, and names an empty one and a null', () => {
    expect(flattenConfig({ a: { b: 1, c: [1, 2] }, d: null, e: [] }, 'x')).toEqual([
      { path: 'x.a.b', value: '1' },
      { path: 'x.a.c', value: '1, 2' },
      { path: 'x.d', value: 'none' },
      { path: 'x.e', value: '(none)' }
    ])
  })
})
