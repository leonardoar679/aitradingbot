import { describe, expect, it } from 'vitest'
import { TRAY_TOOLTIP_MAX_CHARS, closeAction, healKeepRunning, trayTooltip } from '../shared/keepRunning'
import { describeFrameAge, liveMarketStateOf } from '../shared/liveMarketState'

// ALIVE AFTER THE WINDOW IS CLOSED (shared/keepRunning.ts; the V5 document, §98-99; V5 Stage 2).
// The setting heals to off, closing hides only when it is on and nothing asked to quit, and the
// tray's tooltip says the socket, the watch, the open own paper trades and what closing does.

describe('the setting', () => {
  it('is off unless the file says true, in so many words', () => {
    expect(healKeepRunning(true)).toBe(true)
    for (const other of [false, 'true', 'yes', 1, null, undefined, {}]) expect(healKeepRunning(other), JSON.stringify(other)).toBe(false)
  })
})

describe('closing the window', () => {
  it('hides it only with the setting on and no quit asked for', () => {
    expect(closeAction(true, false)).toBe('hide')
    expect(closeAction(true, true)).toBe('quit')
    expect(closeAction(false, false)).toBe('quit')
    expect(closeAction(false, true)).toBe('quit')
  })
})

describe('the tray tooltip', () => {
  it('says the socket, the watch, the trades and what closing does', () => {
    expect(trayTooltip({ state: 'live', ageMs: 400, watchOn: true, ownOpen: 2, keepRunning: true })).toBe(
      'TraderSpider — LIVE · 0.4 s · the watch on · 2 own paper trades open · keeps running when the window is closed'
    )
    expect(trayTooltip({ state: 'off', ageMs: null, watchOn: false, ownOpen: 0, keepRunning: false })).toBe(
      'TraderSpider — LIVE MARKET OFF · the watch off · no own paper trade open · quits when the window is closed'
    )
    expect(trayTooltip({ state: 'quiet', ageMs: 12_000, watchOn: true, ownOpen: 1, keepRunning: false })).toBe(
      'TraderSpider — QUIET 12 s · the watch on · 1 own paper trade open · quits when the window is closed'
    )
    expect(trayTooltip({ state: 'stale', ageMs: 75_000, watchOn: false, ownOpen: 0, keepRunning: true })).toContain('MARKET DATA STALE 75 s')
    expect(trayTooltip({ state: 'reconnecting', ageMs: 2_000, watchOn: false, ownOpen: 0, keepRunning: true })).toContain('RECONNECTING ·')
  })

  it('never runs past what Windows shows', () => {
    const long = trayTooltip({ state: 'stale', ageMs: 9_999_999, watchOn: true, ownOpen: 1_000_000, keepRunning: true })
    expect(long.length).toBeLessThanOrEqual(TRAY_TOOLTIP_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })

  it('reads the socket as the bar does, from the shared state', () => {
    const now = 1_000_000
    expect(liveMarketStateOf(null, now)).toBe('off')
    expect(liveMarketStateOf({ open: false, host: 'a', lastMessageAt: now - 100 }, now)).toBe('reconnecting')
    expect(liveMarketStateOf({ open: true, host: 'a', lastMessageAt: now - 100 }, now)).toBe('live')
    expect(liveMarketStateOf({ open: true, host: 'a', lastMessageAt: now - 15_000 }, now)).toBe('quiet')
    expect(liveMarketStateOf({ open: true, host: 'a', lastMessageAt: now - 61_000 }, now)).toBe('stale')
    expect(describeFrameAge(400)).toBe('0.4 s')
    expect(describeFrameAge(12_400)).toBe('12 s')
  })
})
