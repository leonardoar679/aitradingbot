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
// calibration's and prediction's versions (V7.1 Stage 3) -- from 847feb643cef; the paper laboratory's
// strategies and the risk lines they keep (V7.1 Stage 4) -- from 6e0cea776232. 17 October 2026: the intervals'
// lines -- draws, seed, blocks by horizon, level, the detectable standard deviations, the blocks an interval
// needs -- and the run calibration's version (V7.2 Stage 1) from c05bb1dfdc07; the direction bar's lines -- the skill,
// calls, precision bound, halves, class floor and edge a direction model must hold -- and the run calibration's
// version again (V7.2 Stage 2) from 8ccc65988f1f; the challenger's version and its two new lines -- the newer days a
// refit within noise needs and the paired intervals' level (V7.2 Stage 3) -- from 704b82f0f396; the by-hour
// lines (the outcomes a half needs, the coverage a band fails under or over) and the ablation's blocks (V7.2 Stage
// 4) from 51e30db269e8. 18 October 2026: the pass's and the tape's versions and the fidelity line (V7.2 Stage 5)
// from 637d47de9dc8. 20 October 2026: the AI routing's version, the additions' roles and the bot catch-up (V7.2-R
// Stage 1) from 214afc904bb8; the move odds' version and the moves a close and a path are asked about (V7.2-R Stage
// 3) from 2e0f11aeec10; the decision's version and its line of a move worth its costs, and the prediction's version
// (V7.2-R Stage 3) from 08ce74aa7ac4, and the move rates' version and lines from bfa7312e4b88. 22 October 2026: the
// venues' fees with their dates and sources, the universe's movers and cap, and the decision's version (V7.2-R Stage
// 4) from d44335342657; the pass's version and its line on late outcomes, which move no adaptive level, from 312d3d024ba1.
// The replay out of sample's lines and the two paper strategies that need no way (V7.2-R Stage 5) from 3ffc1762b2e8;
// the replay's intervals resampled by calendar hour (replay-v2) from 2fc505d8429c, under which V72R-S5-* were judged.
// The user's direction hypotheses as rules and their bar (V7.2-R Stage 6) from e4f3e915ddb4; the new blocks of figures
// for the way, research-only (V7.2-R Stage 7), from 3f556fa5a9de. The challenger's shadow week before it is put in use
// (challenger-v3, shadow-v1; V7.2-R Stage 8) from 93ed694aeeb0. 26 October 2026: one budget per host for every public
// read, the hosts' limits, and the limits a task in a worker of its own runs under (V8 Stage 1), from 1142c98ef19f.
// The paper account's equity read as its balance as settled, open stakes no longer counted twice (paper-equity-v2;
// V8 Stage 2), from 140df05699f0.
// The prediction record of every V8 source, the paper books' arithmetic and the liquidity gate (V8 Stage 2),
// from 1098a37acac9. The primary call's lines, the delisting study its card rests on and its live check, and the
// record of large moves (V8 Stage 3), from 4895559f5f13; the study figures the delisting card's coins reproduce, to
// the digits research/news.ts printed them rather than NEWS.md's rounding of them (V8 Stage 3), from 764e875f8492.
// The trade plan's target held to the route's round trip rather than the flat one (trade-plan-v2; V8 Stage 3), from
// bee219d57858. A pasted news link's safe fetch, the page read as text, its time and source, and the record's lines (V8
// Stage 4; infrastructure), from bfd2b18115d7. The article reading's limit and versions (V8 Stage 5; infrastructure),
// from 00c7fa00aefc.
const PINNED_ENGINE_VERSION = 'a15fcdfe59b3'

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
    // No roles or route handed in: none (V8 Stage 0).
    expect(healed.ai).toEqual({ defaultModel: 'openai/gpt-5-mini', enabledModels: ['a/model', 'openai/gpt-5-mini', 'z/model'], dailyCapUsd: 5, callsPerMinute: 60, roles: null, route: null })
    expect(healed.watch.enabled).toBe(true)
    expect(healed.scanner).toEqual({ enabled: true, universeSize: 40 })
    expect(healed.live.allocationQuote).toBe(200)
  })

  it('carries the roles and the route, so the configuration version moves with the routing (V8 Stage 0)', () => {
    const live = { maxOrderQuote: 10, hardMaxOrderQuote: 25, dailyCapQuote: 50, dailyLossLimitQuote: 15, allocationQuote: null, riskPct: 0.25 }
    const ai = { defaultModel: 'anthropic/claude-opus-5.5', enabledModels: ['anthropic/claude-opus-5.5', 'openai/gpt-6-luna@minimal'], dailyCapUsd: 5, callsPerMinute: 30, watch: undefined, watchPaper: undefined, additions: undefined }
    const storesOf = (extra: object) => healStores({ settings: {}, ai: { ...ai, ...extra }, scanner: { enabled: true, universeSize: 60 }, news: undefined, live })
    const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
    const none = storesOf({})
    const routed = storesOf({ roles: { gate: null, summarize: 'openai/gpt-6-luna@minimal' } })
    const second = storesOf({ route: { model: 'openai/gpt-6-luna@minimal', when: 'acting' } })
    expect(routed.ai.roles).toEqual({ gate: null, summarize: 'openai/gpt-6-luna@minimal' })
    expect(second.ai.route).toEqual({ model: 'openai/gpt-6-luna@minimal', when: 'acting' })
    const versions = [none, routed, second].map((stores) => effectiveConfig(stores, hash).configVersion)
    expect(new Set(versions).size).toBe(3)
    // The same routing reads the same whatever the order its fields were written in.
    expect(effectiveConfig(storesOf({ roles: { summarize: 'openai/gpt-6-luna@minimal', gate: null } }), hash).configVersion).toBe(versions[1])
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
