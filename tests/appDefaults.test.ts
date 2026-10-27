import { describe, expect, it } from 'vitest'
import { DEFAULT_ALERTS, healAlerts } from '../shared/alerts'
import { DEFAULT_CONFIG, RISK_MODES, RISK_MODE_PRESETS, describeRiskMode, riskModeOf, riskModePatch, targetLevelOf } from '../shared/appDefaults'
import { DEFAULT_FORECAST_TRADER, healForecastTrader } from '../shared/forecast/trader'
import { DEFAULT_AI_DAILY_CAP_USD, DEFAULT_AI_MODEL, DEFAULT_ENABLED_MODELS } from '../shared/aiSignal'
import { DEFAULT_AI_WATCH, healAiWatch } from '../shared/aiWatch'
import { DEFAULT_AI_WATCH_PAPER, healAiWatchPaper } from '../shared/aiWatchPaper'
import type { PaperPauseSettings } from '../shared/ipc'
import { DEFAULT_KEEP_RUNNING, healKeepRunning } from '../shared/keepRunning'
import { DEFAULT_SCANNER_CONFIG } from '../shared/marketScanner'
import { DEFAULT_NEWS_CONFIG, healNewsConfig } from '../shared/news'
import { DEFAULT_PAPER_DIGEST, healPaperDigest } from '../shared/paperDigest'
import { DEFAULT_PAPER_PAUSE, healPaperPause } from '../shared/paperPause'
import { DEFAULT_PAPER_RISK, healPaperRisk } from '../shared/paperRisk'
import { DEFAULT_UI_MODE, healUiMode } from '../shared/uiMode'
import { DEFAULT_COPY_TRADING, healCopyTrading } from '../shared/traders/copyTrading'
import { tradingModeOf, watchModeOf } from '../src/status/statusModes'

// shared/appDefaults.ts: what a fresh install starts with. The document's "ConfigResolver" is the
// heal function of each store; here each is read empty, and with junk, and must come back as its
// default -- so a default is changed only where it is defined, and a missing setting never reads as
// anything else.

describe('a store read empty, or holding junk, heals to its default', () => {
  const empties: unknown[] = [undefined, null, {}, [], 'junk', 42]
  const stores: { name: string; heal: (value: unknown) => unknown; fallback: unknown }[] = [
    { name: 'paperRisk', heal: healPaperRisk, fallback: DEFAULT_PAPER_RISK },
    { name: 'paperPause', heal: healPaperPause, fallback: DEFAULT_PAPER_PAUSE },
    { name: 'paperDigest', heal: healPaperDigest, fallback: DEFAULT_PAPER_DIGEST },
    { name: 'alerts', heal: healAlerts, fallback: DEFAULT_ALERTS },
    // A fresh install enables the default three (8 October 2026), so the watch offers them, off.
    { name: 'watch', heal: (value) => healAiWatch(value, [...DEFAULT_ENABLED_MODELS]), fallback: DEFAULT_AI_WATCH },
    { name: 'watchPaper', heal: (value) => healAiWatchPaper(value, []), fallback: DEFAULT_AI_WATCH_PAPER },
    { name: 'news', heal: healNewsConfig, fallback: DEFAULT_NEWS_CONFIG },
    { name: 'keepRunningWhenClosed', heal: healKeepRunning, fallback: DEFAULT_KEEP_RUNNING },
    { name: 'uiMode', heal: healUiMode, fallback: DEFAULT_UI_MODE },
    // Following and cloning traders on paper (V8 Stage 8): no one, until a person presses a trader's button.
    { name: 'copyTrading', heal: healCopyTrading, fallback: DEFAULT_COPY_TRADING }
  ]
  for (const store of stores) {
    it(store.name, () => {
      for (const empty of empties) expect(store.heal(empty), `${store.name} from ${JSON.stringify(empty)}`).toEqual(store.fallback)
    })
  }

  it('a fresh install trades nothing real, asks no model by itself, and opens nothing by itself', () => {
    // No key: paper only. The watch, its paper trades and the news rules' shorts are off.
    expect(tradingModeOf({ binanceKey: false, status: null })).toBe('paper-only')
    expect(DEFAULT_AI_WATCH.enabled).toBe(false)
    // Three models offered, the default (the fast one) first and gating; chosen by schema, price and the ledger (8 October 2026).
    expect(DEFAULT_ENABLED_MODELS).toHaveLength(3)
    expect(DEFAULT_ENABLED_MODELS[0]).toBe(DEFAULT_AI_MODEL)
    expect(DEFAULT_AI_WATCH.models).toEqual([...DEFAULT_ENABLED_MODELS])
    expect(DEFAULT_AI_WATCH.firstModelGates).toBe(true)
    expect(DEFAULT_CONFIG.ai.enabledModels).toEqual([...DEFAULT_ENABLED_MODELS].sort())
    expect(watchModeOf({ keyConfigured: false, config: null })).toBe('no-key')
    expect(DEFAULT_AI_WATCH_PAPER.enabled).toBe(false)
    expect(DEFAULT_NEWS_CONFIG.delisting.paperShort.enabled).toBe(false)
    expect(DEFAULT_NEWS_CONFIG.monitoringTag.paperShort.enabled).toBe(false)
    // No trader is followed or cloned on paper (V8 Stage 8).
    expect(DEFAULT_COPY_TRADING).toEqual({ follows: {}, clones: {} })
    expect(DEFAULT_AI_DAILY_CAP_USD).toBe(1)
    // The scanner is free and on from the first launch (since 8 October 2026, the V5 document's
    // §130); the news reader is free too, and waits to be switched on.
    expect(DEFAULT_SCANNER_CONFIG.enabled).toBe(true)
    expect(DEFAULT_CONFIG.scanner).toBe(DEFAULT_SCANNER_CONFIG)
    expect(DEFAULT_NEWS_CONFIG.enabled).toBe(false)
    // Closing the window quits, unless a person switches the tray on (8 October 2026).
    expect(DEFAULT_KEEP_RUNNING).toBe(false)
    expect(DEFAULT_CONFIG.app.keepRunningWhenClosed).toBe(false)
    // The sidebar opens in its normal personality (the V6 document, §65; 13 October 2026).
    expect(DEFAULT_CONFIG.app.uiMode).toBe('normal')
    // Notices are on, with sound, and on the desktop too (silent there: the window plays the sound, V6 Stage 13).
    expect(DEFAULT_ALERTS).toEqual({ enabled: true, sound: true, desktop: true })
    expect(DEFAULT_CONFIG.sounds).toEqual({ volume: 0.7, mutedKinds: [], cooldownSec: 30, quietHours: null })
  })
})

describe('notifications', () => {
  it('only false switches either off', () => {
    expect(healAlerts({ enabled: false, sound: true })).toEqual({ enabled: false, sound: true, desktop: true })
    expect(healAlerts({ enabled: true, sound: true, desktop: false }).desktop).toBe(false)
    expect(healAlerts({ desktop: 'no' }).desktop).toBe(true)
    expect(healAlerts({ enabled: true, sound: false })).toEqual({ enabled: true, sound: false, desktop: true })
    expect(healAlerts({ enabled: 'no', sound: 0 })).toEqual({ enabled: true, sound: true, desktop: true })
  })
})

describe('the risk mode (V6 Stage 12)', () => {
  const pause = { lossR: DEFAULT_PAPER_PAUSE.lossR, trades: DEFAULT_PAPER_PAUSE.trades }
  const trader = { maxOpen: DEFAULT_FORECAST_TRADER.maxOpen, maxSameSide: DEFAULT_FORECAST_TRADER.maxSameSide }

  it('is Conservative at a fresh install, each mode at its own settings, and Custom when any of them is changed, either way', () => {
    expect(RISK_MODE_PRESETS.conservative).toEqual({ paperRisk: DEFAULT_PAPER_RISK, pause: { lossR: 5, trades: 20 }, trader: { maxOpen: 2, maxSameSide: 1 }, targetLevel: 'P75' })
    expect(RISK_MODE_PRESETS.balanced).toEqual({ paperRisk: { sizing: 'equity', riskQuote: 2, riskPct: 0.5, maxOutQuote: 2500, correlatedShare: 0.25 }, pause: { lossR: 8, trades: 20 }, trader: { maxOpen: 4, maxSameSide: 2 }, targetLevel: 'P80' })
    expect(RISK_MODE_PRESETS.aggressive).toEqual({ paperRisk: { sizing: 'equity', riskQuote: 5, riskPct: 1, maxOutQuote: 5000, correlatedShare: 0.35 }, pause: { lossR: 10, trades: 20 }, trader: { maxOpen: 6, maxSameSide: 3 }, targetLevel: 'P90' })
    expect(riskModeOf({ paperRisk: DEFAULT_PAPER_RISK, paperPause: pause, trader })).toBe('conservative')
    expect(riskModeOf({ paperRisk: DEFAULT_PAPER_RISK, paperPause: DEFAULT_PAPER_PAUSE, trader: DEFAULT_FORECAST_TRADER })).toBe('conservative')
    for (const mode of RISK_MODES) {
      const preset = RISK_MODE_PRESETS[mode]
      expect(riskModeOf({ paperRisk: preset.paperRisk, paperPause: preset.pause, trader: preset.trader })).toBe(mode)
      // Every setting a mode sets is one of its choices: a mode is never healed away.
      expect(healPaperRisk(preset.paperRisk)).toEqual(preset.paperRisk)
      expect(healForecastTrader({ ...preset.trader, enabled: true })).toEqual({ ...DEFAULT_FORECAST_TRADER, ...preset.trader, enabled: true })
    }
    const changes = [
      { paperRisk: { ...DEFAULT_PAPER_RISK, sizing: 'risk' as const }, paperPause: pause, trader },
      { paperRisk: { ...DEFAULT_PAPER_RISK, riskQuote: 2 }, paperPause: pause, trader },
      { paperRisk: { ...DEFAULT_PAPER_RISK, riskPct: 0.5 }, paperPause: pause, trader },
      { paperRisk: { ...DEFAULT_PAPER_RISK, maxOutQuote: 500 }, paperPause: pause, trader },
      { paperRisk: { ...DEFAULT_PAPER_RISK, maxOutQuote: null }, paperPause: pause, trader },
      { paperRisk: { ...DEFAULT_PAPER_RISK, correlatedShare: 0.25 }, paperPause: pause, trader },
      { paperRisk: DEFAULT_PAPER_RISK, paperPause: { ...pause, lossR: 3 }, trader },
      { paperRisk: DEFAULT_PAPER_RISK, paperPause: { ...pause, lossR: null }, trader },
      { paperRisk: DEFAULT_PAPER_RISK, paperPause: { ...pause, trades: 50 }, trader },
      { paperRisk: DEFAULT_PAPER_RISK, paperPause: pause, trader: { ...trader, maxOpen: 4 } },
      { paperRisk: DEFAULT_PAPER_RISK, paperPause: pause, trader: { ...trader, maxSameSide: 2 } }
    ]
    for (const changed of changes) expect(riskModeOf(changed), JSON.stringify(changed)).toBe('custom')
    // A profile written before the share was a setting reads it as the 0.15 it was.
    const { correlatedShare: _dropped, ...older } = DEFAULT_PAPER_RISK
    expect(riskModeOf({ paperRisk: older, paperPause: pause, trader })).toBe('conservative')
  })

  it('writes only the paper settings and the trader\'s caps, keeping every pause and whether the trader is on', () => {
    const stored: PaperPauseSettings = { lossR: null, trades: 50, watch: { countFrom: 100, paused: { at: 200, r: -5.5, trades: 6 } }, news: { countFrom: null, paused: null }, forecast: { countFrom: 300, paused: null } }
    const forecast = { refitNightly: false, trader: { enabled: true, stakeQuote: 250, maxOpen: 2, maxSameSide: 1 } }
    const patch = riskModePatch('aggressive', { paperPause: stored, forecast })
    expect(Object.keys(patch).sort()).toEqual(['forecast', 'paperPause', 'paperRisk'])
    expect(patch.paperRisk).toEqual(RISK_MODE_PRESETS.aggressive.paperRisk)
    expect(patch.paperRisk).not.toBe(RISK_MODE_PRESETS.aggressive.paperRisk)
    expect(patch.paperPause).toEqual({ ...stored, lossR: 10, trades: 20 })
    expect(patch.forecast).toEqual({ refitNightly: false, trader: { enabled: true, stakeQuote: 250, maxOpen: 6, maxSameSide: 3 } })
    expect(riskModeOf({ paperRisk: patch.paperRisk, paperPause: patch.paperPause, trader: patch.forecast.trader })).toBe('aggressive')
    // Off, it stays off: a mode is no switch.
    const off = riskModePatch('balanced', { paperPause: stored, forecast: { ...forecast, trader: { ...forecast.trader, enabled: false } } })
    expect(off.forecast.trader).toEqual({ enabled: false, stakeQuote: 250, maxOpen: 4, maxSameSide: 2 })
    expect(targetLevelOf('balanced')).toBe('P80')
    expect(targetLevelOf('custom')).toBe('P75')
  })

  it('says itself in a word and what it holds the paper trades to, and that it never touches the live limits', () => {
    const described = describeRiskMode({ paperRisk: DEFAULT_PAPER_RISK, paperPause: pause, trader })
    expect(described.mode).toBe('conservative')
    expect(described.label).toBe('Conservative')
    expect(described.detail).toBe(
      "For the paper trades the app opens by itself: Each with a stop stakes what would lose about 0.25% of the paper account's equity there, after fees, and never more than its own stake; without a paper account, about 1. Together they stake at most 1,000. Once the last 20 of them to close have lost 5 R together, none is opened until they are resumed on Risk & Safety. The forecast trader keeps at most 2 open, 1 on one side, its target at P75. The limits on real orders are their own, on Risk & Safety: a mode never changes them."
    )
    expect(describeRiskMode({ paperRisk: { ...DEFAULT_PAPER_RISK, maxOutQuote: null }, paperPause: { lossR: null, trades: 20 }, trader }).label).toBe('Custom')
  })
})
