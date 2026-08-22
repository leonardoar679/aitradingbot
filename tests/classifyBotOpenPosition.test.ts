import { describe, it, expect } from 'vitest'
import { classifyBotOpenPosition, summarizePaperTrades } from '../src/bots/useDryRun'
import type { OpenPositionSnapshot, Trade } from '../src/backtest/engine'

const position = (entryTime: number): OpenPositionSnapshot => ({
  entryTime,
  entryPrice: 64346.65,
  qty: 0.1,
  stopPrice: 60000
})

const ENABLED_AT = 1_700_000_000

describe('classifyBotOpenPosition', () => {
  it('reports nothing open when the replay holds no position', () => {
    expect(classifyBotOpenPosition(null, ENABLED_AT)).toEqual({ kind: 'none' })
  })

  it('attributes a position entered after the bot was enabled to the bot', () => {
    const p = position(ENABLED_AT + 3600)
    expect(classifyBotOpenPosition(p, ENABLED_AT)).toEqual({ kind: 'bot', position: p })
  })

  // The observed bug: a bot enabled today reported "Long since Aug 18 (+19.63%)" for an entry
  // three days older than the bot itself.
  it('does NOT attribute a position entered before the bot was enabled', () => {
    const p = position(ENABLED_AT - 3 * 86400)
    expect(classifyBotOpenPosition(p, ENABLED_AT).kind).toBe('preexisting')
  })

  it('counts a position entered exactly at enable time as the bot\'s', () => {
    const p = position(ENABLED_AT)
    expect(classifyBotOpenPosition(p, ENABLED_AT).kind).toBe('bot')
  })

  it('attributes nothing to a bot that has never been enabled, but still carries the position', () => {
    const p = position(ENABLED_AT)
    const result = classifyBotOpenPosition(p, null)
    expect(result.kind).toBe('preexisting')
    expect(result.kind === 'preexisting' && result.position).toBe(p)
  })

  it('still carries the position through, so callers can explain it rather than hide it', () => {
    const p = position(ENABLED_AT - 100)
    const result = classifyBotOpenPosition(p, ENABLED_AT)
    expect(result.kind === 'preexisting' && result.position).toBe(p)
  })
})

// The open position and the closed trades have to agree about what belongs to the bot -- they were
// inconsistent before, which is what let an unearned position through while its eventual exit was
// correctly excluded from the trade count.
describe('open position and closed trades agree on the same cutoff', () => {
  const trade = (entryTime: number): Trade =>
    ({ entryTime, pnl: 100, returnPct: 5 }) as Trade

  it('excludes a pre-enable entry from both', () => {
    const before = ENABLED_AT - 86400
    expect(classifyBotOpenPosition(position(before), ENABLED_AT).kind).toBe('preexisting')
    expect(summarizePaperTrades([trade(before)], ENABLED_AT).paperTrades).toHaveLength(0)
  })

  it('includes a post-enable entry in both', () => {
    const after = ENABLED_AT + 86400
    expect(classifyBotOpenPosition(position(after), ENABLED_AT).kind).toBe('bot')
    expect(summarizePaperTrades([trade(after)], ENABLED_AT).paperTrades).toHaveLength(1)
  })

  it('treats a never-enabled bot as owning nothing in both', () => {
    expect(classifyBotOpenPosition(position(ENABLED_AT), null).kind).toBe('preexisting')
    expect(summarizePaperTrades([trade(ENABLED_AT)], null).paperTrades).toHaveLength(0)
  })
})
