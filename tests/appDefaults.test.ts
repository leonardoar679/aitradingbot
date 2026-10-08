import { describe, expect, it } from 'vitest'
import { DEFAULT_ALERTS, healAlerts } from '../shared/alerts'
import { CONSERVATIVE_PAPER, DEFAULT_CONFIG, conservativePaper, describeRiskLevel, riskLevelOf } from '../shared/appDefaults'
import { DEFAULT_AI_DAILY_CAP_USD, DEFAULT_AI_MODEL } from '../shared/aiSignal'
import { DEFAULT_AI_WATCH, healAiWatch } from '../shared/aiWatch'
import { DEFAULT_AI_WATCH_PAPER, healAiWatchPaper } from '../shared/aiWatchPaper'
import type { PaperPauseSettings } from '../shared/ipc'
import { DEFAULT_KEEP_RUNNING, healKeepRunning } from '../shared/keepRunning'
import { DEFAULT_SCANNER_CONFIG } from '../shared/marketScanner'
import { DEFAULT_NEWS_CONFIG, healNewsConfig } from '../shared/news'
import { DEFAULT_PAPER_DIGEST, healPaperDigest } from '../shared/paperDigest'
import { DEFAULT_PAPER_PAUSE, healPaperPause } from '../shared/paperPause'
import { DEFAULT_PAPER_RISK, healPaperRisk } from '../shared/paperRisk'
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
    { name: 'watch', heal: (value) => healAiWatch(value, [DEFAULT_AI_MODEL]), fallback: DEFAULT_AI_WATCH },
    { name: 'watchPaper', heal: (value) => healAiWatchPaper(value, []), fallback: DEFAULT_AI_WATCH_PAPER },
    { name: 'news', heal: healNewsConfig, fallback: DEFAULT_NEWS_CONFIG },
    { name: 'keepRunningWhenClosed', heal: healKeepRunning, fallback: DEFAULT_KEEP_RUNNING }
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
    expect(watchModeOf({ keyConfigured: false, config: null })).toBe('no-key')
    expect(DEFAULT_AI_WATCH_PAPER.enabled).toBe(false)
    expect(DEFAULT_NEWS_CONFIG.delisting.paperShort.enabled).toBe(false)
    expect(DEFAULT_NEWS_CONFIG.monitoringTag.paperShort.enabled).toBe(false)
    expect(DEFAULT_AI_DAILY_CAP_USD).toBe(1)
    // The scanner is free and on from the first launch (since 8 October 2026, the V5 document's
    // §130); the news reader is free too, and waits to be switched on.
    expect(DEFAULT_SCANNER_CONFIG.enabled).toBe(true)
    expect(DEFAULT_CONFIG.scanner).toBe(DEFAULT_SCANNER_CONFIG)
    expect(DEFAULT_NEWS_CONFIG.enabled).toBe(false)
    // Closing the window quits, unless a person switches the tray on (8 October 2026).
    expect(DEFAULT_KEEP_RUNNING).toBe(false)
    expect(DEFAULT_CONFIG.app.keepRunningWhenClosed).toBe(false)
    // Notices are on, with sound.
    expect(DEFAULT_ALERTS).toEqual({ enabled: true, sound: true })
  })
})

describe('notifications', () => {
  it('only false switches either off', () => {
    expect(healAlerts({ enabled: false, sound: true })).toEqual({ enabled: false, sound: true })
    expect(healAlerts({ enabled: true, sound: false })).toEqual({ enabled: true, sound: false })
    expect(healAlerts({ enabled: 'no', sound: 0 })).toEqual({ enabled: true, sound: true })
  })
})

describe('the risk level', () => {
  const pause = { lossR: DEFAULT_PAPER_PAUSE.lossR, trades: DEFAULT_PAPER_PAUSE.trades }

  it('is Conservative at the shipped defaults, and Custom when any of them is changed, either way', () => {
    expect(CONSERVATIVE_PAPER).toEqual({ paperRisk: DEFAULT_PAPER_RISK, pause: { lossR: 5, trades: 20 } })
    expect(riskLevelOf({ paperRisk: DEFAULT_PAPER_RISK, paperPause: pause })).toBe('conservative')
    expect(riskLevelOf({ paperRisk: DEFAULT_PAPER_RISK, paperPause: DEFAULT_PAPER_PAUSE })).toBe('conservative')
    const changes = [
      { paperRisk: { ...DEFAULT_PAPER_RISK, sizing: 'stake' as const }, paperPause: pause },
      { paperRisk: { ...DEFAULT_PAPER_RISK, riskQuote: 2 }, paperPause: pause },
      { paperRisk: { ...DEFAULT_PAPER_RISK, maxOutQuote: 500 }, paperPause: pause },
      { paperRisk: { ...DEFAULT_PAPER_RISK, maxOutQuote: null }, paperPause: pause },
      { paperRisk: DEFAULT_PAPER_RISK, paperPause: { ...pause, lossR: 3 } },
      { paperRisk: DEFAULT_PAPER_RISK, paperPause: { ...pause, lossR: null } },
      { paperRisk: DEFAULT_PAPER_RISK, paperPause: { ...pause, trades: 50 } }
    ]
    for (const changed of changes) expect(riskLevelOf(changed), JSON.stringify(changed)).toBe('custom')
  })

  it('is put back to Conservative without lifting a pause, which only Resume does', () => {
    const stored: PaperPauseSettings = { lossR: null, trades: 50, watch: { countFrom: 100, paused: { at: 200, r: -5.5, trades: 6 } }, news: { countFrom: null, paused: null } }
    const reset = conservativePaper(stored)
    expect(reset.paperRisk).toEqual(DEFAULT_PAPER_RISK)
    expect(reset.paperRisk).not.toBe(DEFAULT_PAPER_RISK)
    expect(reset.paperPause).toEqual({ ...stored, lossR: 5, trades: 20 })
    expect(riskLevelOf({ paperRisk: reset.paperRisk, paperPause: reset.paperPause })).toBe('conservative')
  })

  it('says itself in a word and what it holds the paper trades to', () => {
    expect(describeRiskLevel({ paperRisk: DEFAULT_PAPER_RISK, paperPause: pause })).toEqual({
      label: 'Conservative',
      detail:
        'For the paper trades the app opens by itself: Each with a stop stakes what would lose about 1 there, after fees, and never more than its own stake. Together they stake at most 1,000. Once the last 20 of them to close have lost 5 R together, none is opened until they are resumed on Risk & Safety.'
    })
    expect(describeRiskLevel({ paperRisk: { ...DEFAULT_PAPER_RISK, maxOutQuote: null }, paperPause: { lossR: null, trades: 20 } }).label).toBe('Custom')
  })
})
