import { CLONE_FEATURES, type CloneRule } from './clone'
import { traderRefOfKey } from './traderRef'

// WHICH TRADERS ARE FOLLOWED OR CLONED ON PAPER (V8 Stage 8, 27 October 2026; settings.json `copyTrading`). A follow
// or a clone runs only from its own button on Copy Traders: a fresh install follows and clones no one, and a stored
// setting out of its shape heals to nothing. A follow keeps when it began -- it enters only positions opened after --
// and the leader's longest hold, its time limit. A clone keeps when it began, the rule the analysis fitted and the
// perpetuals of its coins. What they open goes to the copy book (shared/paperBooks.ts), on paper only.

export interface FollowSetting {
  /** When the follow began, in milliseconds. */
  since: number
  /** The longest a follow of this trader stays open, in seconds: the leader's longest hold, at most seven days. */
  maxHoldSec: number
}

export interface CloneCoin {
  coin: string
  venue: 'binance' | 'bitget'
  symbol: string
}

export interface CloneSetting {
  since: number
  rule: CloneRule
  coins: CloneCoin[]
}

export interface CopyTradingSettings {
  follows: Record<string, FollowSetting>
  clones: Record<string, CloneSetting>
}

export const DEFAULT_COPY_TRADING: CopyTradingSettings = { follows: {}, clones: {} }

/** What a clone's trade keeps of itself, on its executor (`clone`): the signal it was opened on, the perpetual, its
 * size at the perpetual's price, its hold, its fees, and why it closed. */
export interface CloneTradeStamp {
  traderKey: string
  coin: string
  venue: 'binance' | 'bitget'
  symbol: string
  side: 'long' | 'short'
  signalKey: string
  openedAtMs: number
  entryPx: number
  qty: number
  stakeQuote: number
  holdSec: number
  feesQuote: number
  closeReason: 'time' | 'loss cap' | 'stopped' | null
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

function healRule(value: unknown): CloneRule | null {
  const rule = record(value)
  if (rule.side !== 'long' && rule.side !== 'short') return null
  if (!Number.isInteger(rule.holdBars) || !positive(rule.holdBars)) return null
  if (!Array.isArray(rule.conditions) || rule.conditions.length > 2) return null
  const conditions = rule.conditions.map(record)
  for (const condition of conditions) {
    if (!(CLONE_FEATURES as readonly unknown[]).includes(condition.feature) || (condition.op !== '<=' && condition.op !== '>=') || typeof condition.threshold !== 'number' || !Number.isFinite(condition.threshold)) return null
  }
  return { side: rule.side, holdBars: rule.holdBars as number, conditions: conditions as unknown as CloneRule['conditions'] }
}

/** A stored setting read as one: every follow and clone out of its shape, or of a key that names no trader, left out. */
export function healCopyTrading(value: unknown): CopyTradingSettings {
  const raw = record(value)
  const follows: Record<string, FollowSetting> = {}
  for (const [key, entry] of Object.entries(record(raw.follows))) {
    const follow = record(entry)
    if (traderRefOfKey(key) === null || traderRefOfKey(key)?.venue === 'file' || !positive(follow.since) || !positive(follow.maxHoldSec)) continue
    follows[key] = { since: follow.since, maxHoldSec: follow.maxHoldSec }
  }
  const clones: Record<string, CloneSetting> = {}
  for (const [key, entry] of Object.entries(record(raw.clones))) {
    const clone = record(entry)
    const rule = healRule(clone.rule)
    const coins = (Array.isArray(clone.coins) ? clone.coins : []).map(record).filter((coin) => typeof coin.coin === 'string' && (coin.venue === 'binance' || coin.venue === 'bitget') && typeof coin.symbol === 'string' && /^[A-Z0-9]{2,30}$/.test(coin.symbol))
    if (traderRefOfKey(key) === null || !positive(clone.since) || rule === null || coins.length === 0) continue
    clones[key] = { since: clone.since, rule, coins: coins.map((coin) => ({ coin: coin.coin as string, venue: coin.venue as 'binance' | 'bitget', symbol: coin.symbol as string })) }
  }
  return { follows, clones }
}
