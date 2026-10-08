import { app } from 'electron'
import { join } from 'path'
import { readFile, mkdir } from 'fs/promises'
import { writeJsonAtomic } from './atomicWrite'
import { getRealizedPnlToday, getLastObservedFeeRate } from './livePositionsService'
import { DEFAULT_LIVE_RISK_PCT, clampLiveLimit, healLiveRiskPct, liveRiskPctProblem, loadedLiveLimit, describeUnusableOrderSize, describeUntrustedLossTally } from '../../shared/liveLimits'
import { nextDailyUsage, usageForDay } from './dailyUsage'
import { committedAllocationQuote, describeAllocationBreach } from '../../shared/allocation'
import { notionalFor, resolveLeverage } from '../../shared/perp'
import { listOpenLivePositions } from './livePositionsService'
import { listOpenLiveOrders } from './liveOrdersService'
import { liveHealthReasons } from './exchangeHealthService'
import { tell } from './noticeService'
import { breakerNotice } from '../../shared/notices'

// Safety state for real order placement — deliberately its own file, separate from
// settings.json and credentials.json, so a bug in either of those can never weaken a gate here.
// Every check in canPlaceLiveOrder runs server-side (main process), immediately before every
// real order — a renderer-side check is a UX nicety, never the actual gate.

/** Absolute ceiling, code-only. No UI path, no settings.json edit, no IPC call can push
 * maxOrderQuote above this — the only way to raise it is to change this constant and rebuild.
 *
 * Since canPlaceLiveOrder compares this against EXPOSURE rather than against the margin posted,
 * it bounds a leveraged order to 25 of market however that is paid for: 25 of margin at 1x, or
 * 2.50 at 10x. That is deliberate and is the point of a hard ceiling -- the worst thing an order
 * can do is set by what it controls, not by what was put down for it, and a ceiling that let the
 * second number stand in for the first would be a ceiling of 250 wearing a label reading 25. */
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
  /** The managed allocation: the most of the user's real balance this app may have at work at
   * once. Null means no allocation is configured and this gate does not apply -- see
   * shared/allocation.ts. Unlike every other limit here it is not clamped to a hard ceiling,
   * because it can only ever refuse orders the other gates would have allowed. */
  allocationQuote: number | null
  /** The share of the allocation (or the day's cap) a real order filled in from a call is sized to
   * risk at the call's stop: a suggestion for the form (shared/liveLimits.ts), read by no gate. */
  riskPct: number
}

const DEFAULT_STATE: LiveTradingState = {
  killSwitchEngaged: false,
  maxOrderQuote: DEFAULT_MAX_ORDER_QUOTE,
  dailyCapQuote: DEFAULT_DAILY_CAP_QUOTE,
  dailyLossLimitQuote: DEFAULT_DAILY_LOSS_LIMIT_QUOTE,
  dailyUsage: null,
  allocationQuote: null,
  riskPct: DEFAULT_LIVE_RISK_PCT
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
  cache.riskPct = healLiveRiskPct(cache.riskPct)
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
  /** Mirrors the shared LiveTradingStatus fields -- see shared/ipc.ts and shared/allocation.ts. */
  allocationQuote: number | null
  allocationCommittedQuote: number
  riskPct: number
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
    observedFeeRate: await getLastObservedFeeRate(),
    allocationQuote: state.allocationQuote,
    allocationCommittedQuote: state.allocationQuote === null ? 0 : await committedNow(),
    riskPct: state.riskPct
  }
}

/** What this app currently has at work, derived fresh from the live ledgers. Only computed when
 * an allocation exists: it costs two file reads, and reporting a committed figure beside no
 * allocation would invite reading it as a limit. */
async function committedNow(): Promise<number> {
  const [positions, orders] = await Promise.all([listOpenLivePositions(), listOpenLiveOrders()])
  return committedAllocationQuote(positions, orders)
}

/** An allocation is only ever a restriction, so it needs no hard ceiling -- but it does need to
 * be a number, because a stored NaN would reach a gate made of `>` comparisons that are all
 * false against it. Rejected at the door rather than coerced, so the user is told their value
 * was not accepted instead of silently getting a different one. */
function allocationOrThrow(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Managed allocation has to be a number of 0 or more. Clear it to trade without an allocation.')
  }
  return value
}

export async function setLiveTradingConfig(patch: {
  maxOrderQuote?: number
  dailyCapQuote?: number
  dailyLossLimitQuote?: number
  /** null clears the allocation, which turns the gate off; a number sets the ceiling. Absent
   * leaves it alone -- the three shapes have to stay distinguishable, since "clear it" and
   * "don't touch it" mean opposite things for a gate. */
  allocationQuote?: number | null
  /** The share a real order filled in from a call is sized to risk: one of its choices. */
  riskPct?: number
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

  const nextAllocation =
    patch.allocationQuote === undefined
      ? state.allocationQuote
      : patch.allocationQuote === null
        ? null
        : allocationOrThrow(patch.allocationQuote)

  if (patch.riskPct !== undefined) {
    const problem = liveRiskPctProblem(patch.riskPct)
    if (problem !== null) throw new Error(problem)
  }
  const nextRisk = patch.riskPct === undefined ? state.riskPct : patch.riskPct

  state.riskPct = nextRisk
  state.allocationQuote = nextAllocation
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
export async function canPlaceLiveOrder(quoteAmount: number, leverage?: number): Promise<LiveOrderGateResult> {
  // Before any threshold comparison: every check below is a `>` test, and those are all false for
  // NaN, so an unusable size passed the entire gate rather than failing it. See
  // describeUnusableOrderSize.
  const unusableSize = describeUnusableOrderSize(quoteAmount)
  if (unusableSize !== null) return { allowed: false, reason: unusableSize }

  // Two different amounts, and conflating them is how a limit becomes weaker than it reads.
  //
  // quoteAmount is the MARGIN -- the money committed, and the most that can be lost. The size
  // limits below are about EXPOSURE, which above 1x is a different and larger number: 25 at 10x
  // is a 250 order in every way that matters for what it can do to a balance. Comparing the
  // margin against a "max order size of 25" would leave that gate silently ten times weaker than
  // the number printed beside it, which is the worst way for a safety limit to be wrong.
  //
  // resolveLeverage sends anything unusable -- absent, NaN, out of range -- to 1, so spot is
  // unchanged and a leverage that cannot be read can never shrink the notional it is multiplying.
  const effectiveLeverage = resolveLeverage(leverage)
  const notional = notionalFor(quoteAmount, effectiveLeverage)
  const exposureLabel = effectiveLeverage === 1 ? '' : ` (${quoteAmount} at ${effectiveLeverage}x)`

  const state = await load()
  if (!sessionArmed) return { allowed: false, reason: 'Live trading is not armed for this session' }
  if (state.killSwitchEngaged) return { allowed: false, reason: 'Kill switch is engaged' }
  // The exchange's health (shared/exchangeHealth.ts): stale data with REST failing, a clock off
  // Binance's, REST slow three reads running, or a key whose last test failed, and no new real
  // position is opened. An exit is never refused by it: canCloseLivePosition reads none of this.
  const unhealthy = liveHealthReasons()
  if (unhealthy.length > 0) return { allowed: false, reason: `Live trading is paused: ${unhealthy.join('; ')}` }
  if (notional > state.maxOrderQuote) {
    return { allowed: false, reason: `Order exceeds the configured max order size (${state.maxOrderQuote})${exposureLabel}` }
  }
  const usedToday = usageForToday(state)
  if (usedToday + notional > state.dailyCapQuote) {
    return { allowed: false, reason: `Order would exceed today's live trading cap (${state.dailyCapQuote})${exposureLabel}` }
  }
  const realizedPnlToday = await getRealizedPnlToday()
  const untrustedTally = describeUntrustedLossTally(realizedPnlToday)
  if (untrustedTally !== null) return { allowed: false, reason: untrustedTally }
  if (realizedPnlToday <= -state.dailyLossLimitQuote) {
    return { allowed: false, reason: `Daily loss limit reached (${state.dailyLossLimitQuote}) — live trading is disarmed for today` }
  }
  // Last, because it is the only gate that has to read state from two other services and is
  // therefore the only one that can be slow. Committed capital is derived from the positions and
  // resting orders that actually exist rather than from a running total kept alongside them: a
  // second tally drifts the first time anything is missed, and it drifts towards permitting more.
  const [openPositions, restingOrders] = await Promise.all([listOpenLivePositions(), listOpenLiveOrders()])
  const breach = describeAllocationBreach({
    allocationQuote: state.allocationQuote,
    committedQuote: committedAllocationQuote(openPositions, restingOrders),
    // Margin, not notional -- deliberately the opposite choice from the size limits above. An
    // allocation is how much of the user's money this app may put at stake; a leveraged position
    // stakes its margin and borrows the rest, so charging the allocation for the borrowed part
    // would make it refuse orders the user's money could perfectly well back.
    orderQuote: quoteAmount,
    // Every live path in this app is Binance spot against a USD-family quote; the asset is in the
    // message only so the number reads as money rather than as a bare figure.
    quoteAsset: openPositions[0]?.quoteAsset ?? restingOrders[0]?.quoteAsset ?? 'USDT'
  })
  if (breach !== null) return { allowed: false, reason: breach }
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
    const wasArmed = sessionArmed
    sessionArmed = false
    // Told once, when it disarms: a breaker tripped (the V4 document, §48).
    if (wasArmed) {
      tell(
        breakerNotice(
          'live-loss',
          describeUntrustedLossTally(realizedPnlToday) ??
            `Realized ${realizedPnlToday.toFixed(2)} today against a limit of ${state.dailyLossLimitQuote}: the session is disarmed for today. Open positions keep their watchers, which can still close them while the session is armed again.`
        )
      )
    }
  }
}
