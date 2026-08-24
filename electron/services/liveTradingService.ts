import { app } from 'electron'
import { join } from 'path'
import { readFile, mkdir } from 'fs/promises'
import { writeJsonAtomic } from './atomicWrite'
import { getRealizedPnlToday, getLastObservedFeeRate } from './livePositionsService'
import { clampLiveLimit, loadedLiveLimit, describeUnusableOrderSize, describeUntrustedLossTally } from '../../shared/liveLimits'
import { nextDailyUsage, usageForDay } from './dailyUsage'

// Safety state for real order placement — deliberately its own file, separate from
// settings.json and credentials.json, so a bug in either of those can never weaken a gate here.
// Every check in canPlaceLiveOrder runs server-side (main process), immediately before every
// real order — a renderer-side check is a UX nicety, never the actual gate.

/** Absolute ceiling, code-only. No UI path, no settings.json edit, no IPC call can push
 * maxOrderQuote above this — the only way to raise it is to change this constant and rebuild. */
const HARD_MAX_ORDER_QUOTE = 25
const DEFAULT_MAX_ORDER_QUOTE = 10
const DEFAULT_DAILY_CAP_QUOTE = 50
const DEFAULT_DAILY_LOSS_LIMIT_QUOTE = 15

interface DailyUsage {
  date: string // UTC yyyy-mm-dd
  usedQuote: number
}

interface LiveTradingState {
  killSwitchEngaged: boolean
  maxOrderQuote: number
  dailyCapQuote: number
  dailyLossLimitQuote: number
  dailyUsage: DailyUsage | null
}

const DEFAULT_STATE: LiveTradingState = {
  killSwitchEngaged: false,
  maxOrderQuote: DEFAULT_MAX_ORDER_QUOTE,
  dailyCapQuote: DEFAULT_DAILY_CAP_QUOTE,
  dailyLossLimitQuote: DEFAULT_DAILY_LOSS_LIMIT_QUOTE,
  dailyUsage: null
}

// Deliberately never persisted and never set true by default — every app launch starts with
// live trading disarmed, regardless of what was left on in a previous session. This is separate
// from the kill switch: the kill switch is an emergency stop that stays engaged until manually
// cleared; this is the ordinary daily on/off, and it always resets.
let sessionArmed = false

let cache: LiveTradingState | null = null

function liveTradingPath(): string {
  return join(app.getPath('userData'), 'liveTrading.json')
}

async function load(): Promise<LiveTradingState> {
  if (cache) return cache
  try {
    const raw = await readFile(liveTradingPath(), 'utf-8')
    cache = { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<LiveTradingState>) }
  } catch {
    cache = { ...DEFAULT_STATE }
  }
  // Heals a file holding a value that is not a usable number, rather than letting it through to
  // the gates. Falls back to the same defaults a missing file would get.
  cache.maxOrderQuote = loadedLiveLimit(cache.maxOrderQuote, DEFAULT_MAX_ORDER_QUOTE, HARD_MAX_ORDER_QUOTE)
  cache.dailyCapQuote = loadedLiveLimit(cache.dailyCapQuote, DEFAULT_DAILY_CAP_QUOTE, null)
  cache.dailyLossLimitQuote = loadedLiveLimit(cache.dailyLossLimitQuote, DEFAULT_DAILY_LOSS_LIMIT_QUOTE, null)
  return cache
}

async function persist(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(liveTradingPath(), cache)
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function usageForToday(state: LiveTradingState): number {
  return usageForDay(state.dailyUsage, todayUtc())
}

export interface LiveTradingStatus {
  sessionArmed: boolean
  killSwitchEngaged: boolean
  maxOrderQuote: number
  hardMaxOrderQuote: number
  dailyCapQuote: number
  dailyUsedQuote: number
  dailyLossLimitQuote: number
  realizedPnlToday: number
  /** Mirrors the shared LiveTradingStatus field -- see shared/ipc.ts. */
  observedFeeRate: number | null
}

export async function getLiveTradingStatus(): Promise<LiveTradingStatus> {
  const state = await load()
  return {
    sessionArmed,
    killSwitchEngaged: state.killSwitchEngaged,
    maxOrderQuote: state.maxOrderQuote,
    hardMaxOrderQuote: HARD_MAX_ORDER_QUOTE,
    dailyCapQuote: state.dailyCapQuote,
    dailyUsedQuote: usageForToday(state),
    dailyLossLimitQuote: state.dailyLossLimitQuote,
    realizedPnlToday: await getRealizedPnlToday(),
    observedFeeRate: await getLastObservedFeeRate()
  }
}

export async function setLiveTradingConfig(patch: {
  maxOrderQuote?: number
  dailyCapQuote?: number
  dailyLossLimitQuote?: number
}): Promise<LiveTradingStatus> {
  const state = await load()
  // Validated before ANY field is assigned, so a bad third value cannot leave the first two
  // written and the config half-applied.
  const nextMax =
    patch.maxOrderQuote !== undefined
      ? clampLiveLimit('Max order size', patch.maxOrderQuote, HARD_MAX_ORDER_QUOTE)
      : state.maxOrderQuote
  const nextCap =
    patch.dailyCapQuote !== undefined ? clampLiveLimit('Daily cap', patch.dailyCapQuote, null) : state.dailyCapQuote
  const nextLoss =
    patch.dailyLossLimitQuote !== undefined
      ? clampLiveLimit('Daily loss limit', patch.dailyLossLimitQuote, null)
      : state.dailyLossLimitQuote

  state.maxOrderQuote = nextMax
  state.dailyCapQuote = nextCap
  state.dailyLossLimitQuote = nextLoss
  await persist()
  return getLiveTradingStatus()
}

export async function engageKillSwitch(): Promise<LiveTradingStatus> {
  const state = await load()
  state.killSwitchEngaged = true
  sessionArmed = false
  await persist()
  return getLiveTradingStatus()
}

export async function releaseKillSwitch(): Promise<LiveTradingStatus> {
  const state = await load()
  state.killSwitchEngaged = false
  await persist()
  return getLiveTradingStatus()
}

export async function setSessionArmed(armed: boolean): Promise<LiveTradingStatus> {
  const state = await load()
  // Arming is refused outright while the kill switch is engaged — releasing the kill switch is
  // a separate, explicit action, not something arming implicitly does.
  sessionArmed = armed && !state.killSwitchEngaged
  return getLiveTradingStatus()
}

export interface LiveOrderGateResult {
  allowed: boolean
  reason: string | null
}

/** The one function every real *new/opening* order placement must pass. Called immediately
 * before placeMarketOrder — never earlier, never cached. Deliberately NOT used to gate closing a
 * live position — see canCloseLivePosition below for why. */
export async function canPlaceLiveOrder(quoteAmount: number): Promise<LiveOrderGateResult> {
  // Before any threshold comparison: every check below is a `>` test, and those are all false for
  // NaN, so an unusable size passed the entire gate rather than failing it. See
  // describeUnusableOrderSize.
  const unusableSize = describeUnusableOrderSize(quoteAmount)
  if (unusableSize !== null) return { allowed: false, reason: unusableSize }

  const state = await load()
  if (!sessionArmed) return { allowed: false, reason: 'Live trading is not armed for this session' }
  if (state.killSwitchEngaged) return { allowed: false, reason: 'Kill switch is engaged' }
  if (quoteAmount > state.maxOrderQuote) return { allowed: false, reason: `Order exceeds the configured max order size (${state.maxOrderQuote})` }
  const usedToday = usageForToday(state)
  if (usedToday + quoteAmount > state.dailyCapQuote) return { allowed: false, reason: `Order would exceed today's live trading cap (${state.dailyCapQuote})` }
  const realizedPnlToday = await getRealizedPnlToday()
  const untrustedTally = describeUntrustedLossTally(realizedPnlToday)
  if (untrustedTally !== null) return { allowed: false, reason: untrustedTally }
  if (realizedPnlToday <= -state.dailyLossLimitQuote) {
    return { allowed: false, reason: `Daily loss limit reached (${state.dailyLossLimitQuote}) — live trading is disarmed for today` }
  }
  return { allowed: true, reason: null }
}

/** Gates closing an existing live position — deliberately narrower than canPlaceLiveOrder.
 * Only the kill switch and session-arm apply here: never the per-order max, the daily notional
 * cap, or the daily loss limit. Those exist to bound how much *new* risk a single action can
 * create; closing a position only ever reduces risk, so none of them should ever be able to trap
 * someone in a losing position they're trying to exit. */
export async function canCloseLivePosition(): Promise<LiveOrderGateResult> {
  const state = await load()
  if (!sessionArmed) return { allowed: false, reason: 'Live trading is not armed for this session' }
  if (state.killSwitchEngaged) return { allowed: false, reason: 'Kill switch is engaged' }
  return { allowed: true, reason: null }
}

/** Called after a real order actually places — never speculatively. `quoteAmount` can be
 * negative: a resting live limit order reserves its full notional against the daily cap the
 * moment it's placed (capital is committed then, not only once it fills), and a negative delta
 * refunds whatever didn't end up executing once the order resolves (filled less than reserved,
 * or cancelled outright) — see ExecutorPlaceLiveLimitOrder / LiveTradingPollOpenOrders /
 * LiveTradingCancelOrder. Clamped at 0 so a refund can never push usage negative. Pass
 * `reservedAtSec` (the order's placedAt) alongside any refund so it can be discarded when it
 * belongs to a previous UTC day -- see the comment in the body. */
export async function recordLiveOrderUsage(quoteAmount: number, reservedAtSec?: number): Promise<void> {
  const state = await load()
  // Bucket arithmetic lives in dailyUsage.ts so the tests can drive the real thing; null means
  // the adjustment belongs to a day whose bucket is gone, so nothing changes and nothing is
  // written. See nextDailyUsage for why a cross-day refund must be dropped rather than applied.
  const next = nextDailyUsage(state.dailyUsage, todayUtc(), quoteAmount, reservedAtSec)
  if (next === null) return
  state.dailyUsage = next
  await persist()
}

/** Called right after any live SELL fill is recorded. Proactively disarms the session the
 * moment today's realized loss breaches the configured limit, rather than waiting for the next
 * order attempt to discover it via canPlaceLiveOrder — this is the actual "auto-shutoff"
 * behavior the loss limit exists to provide. */
export async function checkLossLimitAndAutoDisarm(): Promise<void> {
  const state = await load()
  const realizedPnlToday = await getRealizedPnlToday()
  // A tally that cannot be totalled disarms too: the auto-shutoff shares the loss limit's `<=`
  // comparison, so without this a poisoned ledger would silently switch off the shutoff as well.
  if (describeUntrustedLossTally(realizedPnlToday) !== null || realizedPnlToday <= -state.dailyLossLimitQuote) {
    sessionArmed = false
  }
}
