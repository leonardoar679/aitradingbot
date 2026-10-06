import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_WATCH } from '../shared/aiWatch'
import { DEFAULT_AI_WATCH_PAPER } from '../shared/aiWatchPaper'
import {
  connectionStateOf,
  describeAiSpend,
  describeConnection,
  describeLiveReadiness,
  describeTradingMode,
  describeWatchMode,
  liveReadinessOf,
  tradingModeOf,
  watchModeOf,
  type ConnectionState,
  type LiveReadiness,
  type TradingMode,
  type WatchMode
} from '../src/status/statusModes'

// The status bar and Overview show the V3 document's modes as what is real (src/status/
// statusModes.ts): whether a real order can be placed comes from the live session's own gates,
// and what the AI does by itself from the watch's setting. These pin both readings.

const session = (over: { sessionArmed?: boolean; killSwitchEngaged?: boolean } = {}): { sessionArmed: boolean; killSwitchEngaged: boolean } => ({
  sessionArmed: false,
  killSwitchEngaged: false,
  ...over
})

describe('the trading mode', () => {
  it('is paper while no Binance key is stored, whatever the session says', () => {
    expect(tradingModeOf({ binanceKey: false, status: session() })).toBe('paper-only')
    expect(tradingModeOf({ binanceKey: false, status: session({ sessionArmed: true }) })).toBe('paper-only')
    expect(tradingModeOf({ binanceKey: true, status: null })).toBe('paper-only')
  })

  it('is paper while disarmed, and live only when armed', () => {
    expect(tradingModeOf({ binanceKey: true, status: session() })).toBe('paper')
    expect(tradingModeOf({ binanceKey: true, status: session({ sessionArmed: true }) })).toBe('live-armed')
  })

  it('is the kill switch whenever it is engaged, before anything else', () => {
    expect(tradingModeOf({ binanceKey: true, status: session({ sessionArmed: true, killSwitchEngaged: true }) })).toBe('kill-switch')
    expect(tradingModeOf({ binanceKey: false, status: session({ killSwitchEngaged: true }) })).toBe('kill-switch')
  })

  it('reads paper as safe and armed as live, and never says a model can place an order', () => {
    const modes: TradingMode[] = ['paper-only', 'paper', 'live-armed', 'kill-switch']
    expect(modes.map((mode) => [describeTradingMode(mode).label, describeTradingMode(mode).tone])).toEqual([
      ['PAPER', 'safe'],
      ['PAPER', 'safe'],
      ['LIVE ARMED', 'live'],
      ['KILL SWITCH', 'blocked']
    ])
    expect(describeTradingMode('live-armed').detail).toContain('No model can place one.')
    for (const mode of modes) expect(describeTradingMode(mode).detail).not.toMatch(/(?<!No )model (can|may|will) place/i)
  })
})

describe('the watch mode', () => {
  const config = (watch: boolean, paper: boolean): { watch: typeof DEFAULT_AI_WATCH; watchPaper: typeof DEFAULT_AI_WATCH_PAPER } => ({
    watch: { ...DEFAULT_AI_WATCH, enabled: watch, models: ['openai/gpt-5-mini'] },
    watchPaper: { ...DEFAULT_AI_WATCH_PAPER, enabled: paper, model: 'openai/gpt-5-mini' }
  })

  it('has nothing to do without a key', () => {
    expect(watchModeOf({ keyConfigured: false, config: config(true, true) })).toBe('no-key')
  })

  it('is off while the watch is, even with paper trades switched on, since the watch is what opens them', () => {
    expect(watchModeOf({ keyConfigured: true, config: config(false, false) })).toBe('off')
    expect(watchModeOf({ keyConfigured: true, config: config(false, true) })).toBe('off')
    expect(watchModeOf({ keyConfigured: true, config: null })).toBe('off')
  })

  it('is shadow when the watch asks and scores, and paper trades when it also opens paper positions', () => {
    expect(watchModeOf({ keyConfigured: true, config: config(true, false) })).toBe('shadow')
    expect(watchModeOf({ keyConfigured: true, config: config(true, true) })).toBe('paper-trades')
  })

  it('says shadow opens nothing and paper trades are never real', () => {
    const modes: WatchMode[] = ['no-key', 'off', 'shadow', 'paper-trades']
    expect(modes.map((mode) => describeWatchMode(mode).label)).toEqual(['AI: NO KEY', 'AI: WATCH OFF', 'AI: SHADOW', 'AI: PAPER TRADES'])
    expect(describeWatchMode('shadow').detail).toContain('opens nothing')
    expect(describeWatchMode('paper-trades').detail).toContain('Never a real one.')
  })

  it("states the day's spend against its budget", () => {
    expect(describeAiSpend({ spentTodayUsd: 0.42, dailyCapUsd: 5 })).toBe('$0.42 of $5.00 today')
  })
})

describe('a connection', () => {
  it('reads a stored key as connected until a later test fails', () => {
    expect(connectionStateOf(undefined)).toBe('none')
    expect(connectionStateOf({ configured: false, lastTestOk: null })).toBe('none')
    expect(connectionStateOf({ configured: true, lastTestOk: null })).toBe('ok')
    expect(connectionStateOf({ configured: true, lastTestOk: true })).toBe('ok')
    expect(connectionStateOf({ configured: true, lastTestOk: false })).toBe('failed')
  })

  it('names the exchange and sends someone to Connections when it needs a key', () => {
    expect(describeConnection('Binance', 'none')).toEqual({ label: 'BINANCE: NO KEY', detail: 'No Binance key is stored. Add one on Connections.', tone: 'muted' })
    expect(describeConnection('Binance', 'ok').tone).toBe('safe')
    expect(describeConnection('Binance', 'failed').label).toBe('BINANCE: TEST FAILED')
  })
})

describe('live readiness, for Settings', () => {
  // The V3 document: live trading can be READY without being ACTIVE. Ready is a stored key whose
  // last test passed, with the session disarmed; active is the session armed.
  it('is ready only with a verified key and a disarmed session, and active only when armed', () => {
    const cases: [TradingMode, ConnectionState, LiveReadiness][] = [
      ['paper-only', 'none', 'paper-only'],
      ['paper-only', 'ok', 'paper-only'],
      ['paper', 'none', 'paper-only'],
      ['paper', 'failed', 'not-verified'],
      ['paper', 'ok', 'ready'],
      ['live-armed', 'ok', 'active'],
      ['live-armed', 'failed', 'active'],
      ['kill-switch', 'ok', 'blocked'],
      ['kill-switch', 'none', 'blocked']
    ]
    for (const [mode, connection, readiness] of cases) expect(liveReadinessOf({ mode, connection }), `${mode} ${connection}`).toBe(readiness)
  })

  it('says ready is not active, and that no model can place an order either way', () => {
    expect(describeLiveReadiness('ready').label).toBe('PAPER · LIVE READY')
    expect(describeLiveReadiness('ready').detail).toMatch(/no real order can be placed until it is armed/)
    expect(describeLiveReadiness('active')).toMatchObject({ label: 'LIVE ACTIVE', tone: 'live' })
    expect(describeLiveReadiness('active').detail).toMatch(/No model can place one\.$/)
    expect(describeLiveReadiness('not-verified').tone).toBe('warn')
    expect(describeLiveReadiness('blocked').label).toBe('KILL SWITCH')
    expect(describeLiveReadiness('paper-only').label).toBe('PAPER')
  })
})
