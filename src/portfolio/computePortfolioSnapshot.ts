import type { Exchange, HeldPosition } from '../../shared/ipc'
import { computeExecutorPosition } from '../executors/computeSnapshot'
import { fetchBotDryRunResult, summarizePaperTrades } from '../bots/useDryRun'
import { isUsdLikeQuote } from '../utils/formatCurrency'
import { availableBalance } from '../account/paperAccount'

export interface PortfolioHoldingRow {
  baseAsset: string
  quoteAsset: string
  value: number
  isLive: boolean
}

export interface PortfolioSnapshotData {
  totalValue: number
  holdings: PortfolioHoldingRow[]
  activeExecutorCount: number
  /** Simple mean of paperNetPct across enabled bots that have at least one paper trade so far.
   * Null means no enabled bot has traded yet — distinct from an honest 0%. */
  botsAggregatePct: number | null
  /** Things left out of totalValue because something FAILED, as opposed to the currency rule
   * above, which leaves out non-dollar holdings on purpose and already says so.
   *
   * Each of these was previously swallowed: a ticker that would not fetch made its position
   * `continue` out of the rows list, a paper executor whose position could not be computed was
   * caught to null, and a bot whose dry run threw was dropped from the average. All three
   * silently shrink the headline numbers on the app's landing page, and none of them said a
   * word. The failures themselves are fine -- one bad symbol must not block the whole snapshot --
   * but the total has to admit what is missing from it. */
  unavailable: {
    /** Open positions dropped because no price could be fetched for them this tick. */
    unpricedPositions: number
    /** Paper executors whose position could not be computed. */
    failedExecutors: number
    /** Enabled bots whose dry run could not be produced, so they are absent from the average. */
    failedBots: number
  }
}

function priceKey(exchange: Exchange, symbol: string): string {
  return `${exchange}:${symbol}`
}

/** Current value of an open paper position (a held/handed-over position, or a still-running
 * executor's open position) — same unrealized-%-then-apply-to-amountQuote math already used by
 * HeldPositionRow.tsx and BotCard.tsx, just centralized here so Portfolio computes it exactly
 * the same way those views display it. */
function paperPositionValue(
  entryPrice: number,
  amountQuote: number,
  side: 'buy' | 'sell',
  price: number,
  leverage = 1
): number {
  const rawPct = (price - entryPrice) / entryPrice
  const pct = side === 'sell' ? -rawPct : rawPct
  // What the position is worth to its holder: the money they put in, moved by the price change
  // times the leverage. amountQuote stays the margin -- reporting the notional would tell someone
  // with 1,000 at 10x that they hold 10,000, which is a figure they have never owned.
  //
  // Never below zero. An isolated-margin position stops at "the deposit is gone"; a negative
  // holding row would subtract from the portfolio total as though the loss kept going.
  return Math.max(amountQuote * (1 + pct * leverage), 0)
}

/** Aggregates real portfolio state from every source this app actually tracks -- live
 * (real-money) positions, paper positions handed over from stopped executors, and open positions
 * inside still-running paper executors -- into one snapshot. Nothing here is persisted; call
 * this fresh every time (see PortfolioScheduler.tsx for the periodic caller). Live and paper
 * holdings are kept as separate rows even for the same asset (see PortfolioHoldingRow.isLive) so
 * real money is never silently blended with paper. Only USD-family quoted holdings
 * (isUsdLikeQuote) count toward totalValue -- there's no exchange-rate table anywhere in this
 * app, so a KRW-quoted holding (Korean exchanges are genuinely supported elsewhere) would
 * otherwise get silently mis-summed into a dollar figure. */
export async function computePortfolioSnapshot(): Promise<PortfolioSnapshotData> {
  const settings = await window.api.settings.get()
  const activeExecutors = settings.executors.filter((e) => e.status === 'active')
  const paperExecutors = activeExecutors.filter((e) => e.mode !== 'live')
  const enabledBots = settings.bots.filter((b) => b.enabled)

  const [livePositions, paperExecutorPositions, botDryRuns] = await Promise.all([
    window.api.liveTrading.listPositions(),
    Promise.all(
      // A thrown error and a legitimate "this executor holds nothing" both produced null before,
      // so a broken executor was indistinguishable from a flat one.
      paperExecutors.map(async (executor) => {
        try {
          return { executor, position: await computeExecutorPosition(executor), failed: false }
        } catch {
          return { executor, position: null, failed: true }
        }
      })
    ),
    Promise.all(
      enabledBots.map(async (bot) => {
        try {
          return { bot, dryRun: await fetchBotDryRunResult(bot), failed: false }
        } catch {
          return { bot, dryRun: null, failed: true }
        }
      })
    )
  ])

  const prices = new Map<string, number>()
  const keysNeeded = new Set<string>()
  for (const p of livePositions) keysNeeded.add(priceKey(p.exchange, p.symbol))
  for (const { executor, position } of paperExecutorPositions) {
    if (position) keysNeeded.add(priceKey(executor.exchange, executor.symbol))
  }
  for (const h of settings.heldPositions) keysNeeded.add(priceKey(h.exchange, h.symbol))

  await Promise.all(
    [...keysNeeded].map(async (key) => {
      const [exchange, symbol] = key.split(':') as [Exchange, string]
      try {
        const ticker = await window.api.market.fetchTicker24h(exchange, symbol)
        prices.set(key, ticker.lastPrice)
      } catch {
        // No price this tick -- the position just doesn't contribute to the snapshot rather than
        // blocking the whole computation on one bad symbol.
      }
    })
  )

  const rows: PortfolioHoldingRow[] = []
  let unpricedPositions = 0

  // Uncommitted cash in the paper account. AVAILABLE, not total: money a running strategy holds
  // is already represented by that strategy's open position below, and counting both would show
  // the same funds twice. Money that became an Inventory position left the balance when the
  // position was handed over, for the same reason.
  //
  // Cash is a holding with no base asset, so it is listed under its own currency. Only the
  // dollar family folds into totalValue, exactly as every other row does.
  // What the running paper strategies actually hold in the market, at what it cost them.
  //
  // NOT their full allocation. committedByAsset fences off an executor's whole stake so a second
  // strategy cannot be funded with the same money -- the right rule for the Account page, and
  // wrong twice over as a valuation. The cash never left the balance (a paper executor's result
  // reaches the account only when it stops), and the part not yet in the market is still money the
  // user has. Subtracting the whole stake while adding back only the open lots is what made
  // starting a 1,000 grid with three of its thirteen rungs filled read as 770 of the user's own
  // money missing from Total Value: cash 10,000 in the account, 9,229.64 on the screen.
  //
  // Only positions that will actually get a row below are counted. Deducting the cost of a
  // position that could not be priced would understate the total in exactly the way this fixes.
  const deployed: Record<string, number> = {}
  for (const { executor, position } of paperExecutorPositions) {
    if (!position) continue
    if (prices.get(priceKey(executor.exchange, executor.symbol)) === undefined) continue
    if (!Number.isFinite(position.amountQuote) || position.amountQuote <= 0) continue
    deployed[executor.quoteAsset] = (deployed[executor.quoteAsset] ?? 0) + position.amountQuote
  }

  if (settings.paperAccount) {
    for (const asset of Object.keys(settings.paperAccount.balances)) {
      const cash = availableBalance(settings.paperAccount, asset, deployed[asset] ?? 0)
      if (cash === 0 || !Number.isFinite(cash)) continue
      rows.push({ baseAsset: asset, quoteAsset: asset, value: cash, isLive: false })
    }
  }

  for (const p of livePositions) {
    const price = prices.get(priceKey(p.exchange, p.symbol))
    if (price === undefined) {
      unpricedPositions++
      continue
    }
    rows.push({ baseAsset: p.baseAsset, quoteAsset: p.quoteAsset, value: p.qty * price, isLive: true })
  }

  for (const { executor, position } of paperExecutorPositions) {
    if (!position) continue
    const price = prices.get(priceKey(executor.exchange, executor.symbol))
    if (price === undefined) {
      unpricedPositions++
      continue
    }
    rows.push({
      baseAsset: executor.baseAsset,
      quoteAsset: executor.quoteAsset,
      value: paperPositionValue(position.entryPrice, position.amountQuote, position.side, price, position.leverage),
      isLive: false
    })
  }

  for (const h of settings.heldPositions as HeldPosition[]) {
    const price = prices.get(priceKey(h.exchange, h.symbol))
    if (price === undefined) {
      unpricedPositions++
      continue
    }
    rows.push({
      baseAsset: h.baseAsset,
      quoteAsset: h.quoteAsset,
      value: paperPositionValue(h.entryPrice, h.amountQuote, h.side, price),
      isLive: false
    })
  }

  // Group by (baseAsset, quoteAsset, isLive) -- quoteAsset stays part of the key so e.g. a paper
  // BTC/USDT row and a paper BTC/KRW row are never summed as if they were the same currency.
  const grouped = new Map<string, PortfolioHoldingRow>()
  for (const row of rows) {
    const key = `${row.baseAsset}:${row.quoteAsset}:${row.isLive}`
    const existing = grouped.get(key)
    if (existing) existing.value += row.value
    else grouped.set(key, { ...row })
  }
  // Sorting purely by `value` compared raw numbers across currencies, so a ₩800,000 holding
  // (about $600) outranked a $5,000 one simply because 800,000 > 5,000. Dollar-quoted rows --
  // the ones that make up the headline total -- come first and are ordered against each other;
  // every other currency follows, grouped so its rows are at least ranked among their own kind.
  const holdings = [...grouped.values()].sort((a, b) => {
    const aUsd = isUsdLikeQuote(a.quoteAsset)
    const bUsd = isUsdLikeQuote(b.quoteAsset)
    if (aUsd !== bUsd) return aUsd ? -1 : 1
    if (!aUsd && a.quoteAsset !== b.quoteAsset) return a.quoteAsset.localeCompare(b.quoteAsset)
    return b.value - a.value
  })

  const totalValue = holdings.reduce((sum, row) => (isUsdLikeQuote(row.quoteAsset) ? sum + row.value : sum), 0)

  const tradedBotPcts = botDryRuns
    .filter(({ dryRun }) => dryRun !== null)
    .map(({ bot, dryRun }) => summarizePaperTrades(dryRun!.result.trades, bot.enabledAt))
    .filter((summary) => summary.paperTrades.length > 0)
    .map((summary) => summary.paperNetPct)
  const botsAggregatePct = tradedBotPcts.length > 0 ? tradedBotPcts.reduce((sum, pct) => sum + pct, 0) / tradedBotPcts.length : null

  return {
    totalValue,
    holdings,
    activeExecutorCount: activeExecutors.length,
    botsAggregatePct,
    unavailable: {
      unpricedPositions,
      failedExecutors: paperExecutorPositions.filter((e) => e.failed).length,
      failedBots: botDryRuns.filter((b) => b.failed).length
    }
  }
}
