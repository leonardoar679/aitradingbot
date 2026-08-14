import type { Exchange, HeldPosition } from '../../shared/ipc'
import { computeExecutorPosition } from '../executors/computeSnapshot'
import { fetchBotDryRunResult, summarizePaperTrades } from '../bots/useDryRun'
import { isUsdLikeQuote } from '../utils/formatCurrency'

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
}

function priceKey(exchange: Exchange, symbol: string): string {
  return `${exchange}:${symbol}`
}

/** Current value of an open paper position (a held/handed-over position, or a still-running
 * executor's open position) — same unrealized-%-then-apply-to-amountQuote math already used by
 * HeldPositionRow.tsx and BotCard.tsx, just centralized here so Portfolio computes it exactly
 * the same way those views display it. */
function paperPositionValue(entryPrice: number, amountQuote: number, side: 'buy' | 'sell', price: number): number {
  const rawPct = (price - entryPrice) / entryPrice
  const pct = side === 'sell' ? -rawPct : rawPct
  return amountQuote * (1 + pct)
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
      paperExecutors.map(async (executor) => ({
        executor,
        position: await computeExecutorPosition(executor).catch(() => null)
      }))
    ),
    Promise.all(
      enabledBots.map(async (bot) => ({
        bot,
        dryRun: await fetchBotDryRunResult(bot).catch(() => null)
      }))
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

  for (const p of livePositions) {
    const price = prices.get(priceKey(p.exchange, p.symbol))
    if (price === undefined) continue
    rows.push({ baseAsset: p.baseAsset, quoteAsset: p.quoteAsset, value: p.qty * price, isLive: true })
  }

  for (const { executor, position } of paperExecutorPositions) {
    if (!position) continue
    const price = prices.get(priceKey(executor.exchange, executor.symbol))
    if (price === undefined) continue
    rows.push({
      baseAsset: executor.baseAsset,
      quoteAsset: executor.quoteAsset,
      value: paperPositionValue(position.entryPrice, position.amountQuote, position.side, price),
      isLive: false
    })
  }

  for (const h of settings.heldPositions as HeldPosition[]) {
    const price = prices.get(priceKey(h.exchange, h.symbol))
    if (price === undefined) continue
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
  const holdings = [...grouped.values()].sort((a, b) => b.value - a.value)

  const totalValue = holdings.reduce((sum, row) => (isUsdLikeQuote(row.quoteAsset) ? sum + row.value : sum), 0)

  const tradedBotPcts = botDryRuns
    .filter(({ dryRun }) => dryRun !== null)
    .map(({ bot, dryRun }) => summarizePaperTrades(dryRun!.result.trades, bot.enabledAt))
    .filter((summary) => summary.paperTrades.length > 0)
    .map((summary) => summary.paperNetPct)
  const botsAggregatePct = tradedBotPcts.length > 0 ? tradedBotPcts.reduce((sum, pct) => sum + pct, 0) / tradedBotPcts.length : null

  return { totalValue, holdings, activeExecutorCount: activeExecutors.length, botsAggregatePct }
}
