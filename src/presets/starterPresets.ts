import { FEE_RATE } from '../../shared/fees'
import type { ControllerConfig, ControllerRiskControls, Exchange, ExecutorConfig, ExecutorType } from '../../shared/ipc'

// Starting configurations for someone who has never set up a trading bot.
//
// These are adapted from the strategies Hummingbot ships and its users actually run -- this app
// borrows Hummingbot's whole vocabulary (Controllers supervising Executors, and a Position
// executor whose take-profit / stop-loss / time-limit / trailing-stop set is their "triple
// barrier"), so its defaults are the right reference point rather than invented numbers.
//
// What these are NOT: a way to predict price, or a setting that earns a profit. Nothing here
// forecasts anything. Every preset below is a rule for how to ENTER, how much to risk, and when
// to give up -- which is the part a newcomer can actually get wrong in a way that costs real
// money. Each one carries the conditions under which it loses, because a preset that only
// advertises its upside is how a beginner gets hurt.
//
// All of them are created in PAPER mode. That is Hummingbot's own standing advice to new users,
// and it is the only honest default: none of this has been proven against real money.

/** A round trip pays the fee twice, so this is the floor in percent that any profit target has
 * to clear before the trade is worth taking at all. At the 0.1%-per-side rate in shared/fees.ts
 * that is 0.2% -- a "0.1% take profit" is not a small win, it is a guaranteed loss. Every target
 * below is chosen against this number, and starterPresets.test.ts enforces it. */
export const ROUND_TRIP_FEE_PCT = FEE_RATE * 2 * 100

export type PresetRisk = 'conservative' | 'moderate' | 'advanced'

export interface StarterPreset {
  id: string
  name: string
  /** The Hummingbot strategy or executor this mirrors, so its docs and community threads are
   * findable by name. */
  hummingbot: string
  risk: PresetRisk
  type: ExecutorType
  exchange: Exchange
  symbol: string
  baseAsset: string
  quoteAsset: string
  /** One line, shown on the card. */
  summary: string
  /** Plain language, no jargon -- what it will actually do once started. */
  howItWorks: string
  /** The conditions under which this loses money. Not a disclaimer: the specific failure mode. */
  whenItLosesMoney: string
  /** Grid quotes absolute prices, so it cannot be built without knowing what the market costs
   * right now. Everything else ignores the reference price. */
  needsReferencePrice: boolean
  /** Can never run live in this app, regardless of what the user picks. */
  paperOnly: boolean
  keepPosition: boolean
  buildParams: (referencePrice: number) => ExecutorConfig['params']
}

const BINANCE = { exchange: 'binance' as Exchange, symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }
// The Korean venues quote the same pair against KRW and routinely diverge from the global price
// (the "kimchi premium"), which is why they are the standard example for the two spread
// strategies -- and why the repo already defaults its spread executors to exactly this pair.
const BITHUMB = { exchange: 'bithumb' as Exchange, symbol: 'BTC_KRW', baseAsset: 'BTC', quoteAsset: 'KRW' }
const UPBIT = { exchange: 'upbit' as Exchange, symbol: 'BTC-KRW', baseAsset: 'BTC', quoteAsset: 'KRW' }

export const STARTER_PRESETS: StarterPreset[] = [
  {
    id: 'twap-accumulate',
    name: 'Slow Accumulation',
    hummingbot: 'TWAP Executor',
    risk: 'conservative',
    type: 'twap',
    ...BINANCE,
    summary: 'Buys a fixed amount in equal slices over six hours instead of all at once.',
    howItWorks:
      'Splits 600 USDT into twelve 50 USDT buys, one every thirty minutes. You end up paying the average price across the window rather than whatever the price happened to be the moment you clicked.',
    whenItLosesMoney:
      'It does not protect you from a falling market -- it only spreads out when you bought. If price rises steadily through the window you pay more than buying once at the start. It has no stop loss because it never decides to exit; it only decides how to enter.',
    needsReferencePrice: false,
    paperOnly: false,
    keepPosition: true,
    buildParams: () => ({ side: 'buy', totalAmountQuote: 600, totalDurationSec: 21_600, orderIntervalSec: 1_800 })
  },
  {
    id: 'dca-dip-ladder',
    name: 'Dip Ladder',
    hummingbot: 'DCA Executor (the "DMAN" controllers)',
    risk: 'conservative',
    type: 'dca',
    ...BINANCE,
    summary: 'Places four buy orders below the current price, larger the further down it goes.',
    howItWorks:
      'Waits at 1%, 2%, 3% and 5% below the price when you started, buying 100, 150, 200 and 250 USDT respectively. If the whole ladder fills, the average entry sits well below where you began. It closes the lot at 2% profit, or cuts it at 8% down.',
    whenItLosesMoney:
      'A market that falls straight through every level and keeps going. The ladder is fully loaded exactly when the trend is against you, and the 8% stop then closes all of it at a loss. Buying more as something falls only helps if it comes back.',
    needsReferencePrice: false,
    paperOnly: false,
    keepPosition: true,
    buildParams: () => ({
      side: 'buy',
      levels: [
        { priceOffsetPct: 1, amountQuote: 100 },
        { priceOffsetPct: 2, amountQuote: 150 },
        { priceOffsetPct: 3, amountQuote: 200 },
        { priceOffsetPct: 5, amountQuote: 250 }
      ],
      takeProfitPct: 2,
      stopLossPct: 8,
      timeLimitSec: null
    })
  },
  {
    id: 'position-triple-barrier',
    name: 'Triple Barrier Trade',
    hummingbot: 'PositionExecutor with TripleBarrierConfig',
    risk: 'moderate',
    type: 'position',
    ...BINANCE,
    summary: 'One position that always has an exit: a target, a stop, a trailing stop and a deadline.',
    howItWorks:
      'Buys 500 USDT at the market and arms four exits at once. Takes profit at +3%. Cuts the loss at -1.5%. Once it is up 2%, a trailing stop follows the high 1% behind, so a winner that reverses still closes green. If none of that happens within 24 hours it closes anyway. This four-way exit is the idea a newcomer most needs: the decision to leave is made before you are emotionally involved.',
    whenItLosesMoney:
      'A market that chops sideways. Each swing takes out the 1.5% stop, you re-enter, and it happens again -- several small losses in a row, each paying fees. Note the real reward-to-risk after fees is nearer 1.65:1 than the 2:1 that the raw 3% and 1.5% suggest.',
    needsReferencePrice: false,
    paperOnly: false,
    keepPosition: true,
    buildParams: () => ({
      side: 'buy',
      entryPrice: null,
      amountQuote: 500,
      takeProfitPct: 3,
      stopLossPct: 1.5,
      timeLimitSec: 86_400,
      trailingStop: { activationPct: 2, trailPct: 1 }
    })
  },
  {
    id: 'grid-range',
    name: 'Range Grid',
    hummingbot: 'Grid Strike controller',
    risk: 'moderate',
    type: 'grid',
    ...BINANCE,
    summary: 'Buys each step down inside a band and sells each one back 1% higher.',
    howItWorks:
      'Lays buy levels roughly 1% apart across a band 4% either side of the price when you started, 800 USDT spread across them, at most 4 open at once. Every level that fills is sold again 1% up, and the same level can cycle repeatedly. A hard stop 6% below the band closes everything and freezes the grid for good.',
    whenItLosesMoney:
      'Any market that picks a direction. A grid earns from price oscillating inside its band; a breakout leaves every level filled and falling, which is what the stop below the band is for. It is the opposite of a trend strategy, and running it during a trend is the classic beginner mistake.',
    needsReferencePrice: true,
    paperOnly: false,
    keepPosition: true,
    buildParams: (ref) => ({
      side: 'buy',
      startPrice: Number((ref * 0.96).toFixed(2)),
      endPrice: Number((ref * 1.04).toFixed(2)),
      totalAmountQuote: 800,
      maxOpenOrders: 4,
      levelSpreadPct: 1,
      takeProfitPct: 1,
      limitPrice: Number((ref * 0.94).toFixed(2))
    })
  },
  {
    id: 'pure-market-making',
    name: 'Pure Market Making',
    hummingbot: 'pure_market_making, the Hummingbot flagship strategy',
    risk: 'advanced',
    type: 'marketmaking',
    ...BINANCE,
    summary: 'Quotes a buy and a sell either side of the price and earns the gap between them.',
    howItWorks:
      'Posts a bid 0.5% below and an ask 0.5% above the current price, 100 USDT each, replaced every 60 seconds. A full round trip captures the 1% gap, which is 0.8% after fees. It also steers back toward holding half its value in BTC, so a run of one-sided fills nudges the quotes to correct the imbalance.',
    whenItLosesMoney:
      'A market that trends. You are always buying from sellers and selling to buyers, so in a sustained fall you keep buying all the way down. That is inventory risk, and it is why most market makers lose money -- far more often than the spread being too thin. Paper only in this app.',
    needsReferencePrice: false,
    paperOnly: true,
    keepPosition: true,
    buildParams: () => ({
      side: 'both',
      spreadPct: 1,
      orderRefreshSec: 60,
      orderAmountQuote: 100,
      inventoryTargetPct: 50,
      inventorySkewIntensity: 0.5
    })
  },
  {
    id: 'xemm-korea',
    name: 'Cross-Exchange Market Making',
    hummingbot: 'cross_exchange_market_making',
    risk: 'advanced',
    type: 'xemm',
    ...BITHUMB,
    summary: 'Quotes on one exchange and immediately hedges the fill on another.',
    howItWorks:
      'Watches Bithumb and Upbit, both quoting BTC in KRW. When the gap between them is worth more than 0.6%, it treats that as a fill worth taking on one side and covering on the other. Unlike plain market making it does not hold a directional position -- the hedge closes it straight away.',
    whenItLosesMoney:
      'The gap closes before both legs are done, leaving you holding only the losing half. The simulation here also cannot model the parts that decide whether this works in reality: transfer times between exchanges, withdrawal limits, and having capital already sitting on both sides. Paper only in this app.',
    needsReferencePrice: false,
    paperOnly: true,
    keepPosition: false,
    buildParams: () => ({
      buyingMarket: { exchange: BITHUMB.exchange, symbol: BITHUMB.symbol, baseAsset: BITHUMB.baseAsset, quoteAsset: BITHUMB.quoteAsset },
      sellingMarket: { exchange: UPBIT.exchange, symbol: UPBIT.symbol, baseAsset: UPBIT.baseAsset, quoteAsset: UPBIT.quoteAsset },
      orderAmountQuote: 300,
      minProfitabilityPct: 0.6
    })
  },
  {
    id: 'arbitrage-korea',
    name: 'Cross-Exchange Arbitrage',
    hummingbot: 'arbitrage',
    risk: 'advanced',
    type: 'arbitrage',
    ...BITHUMB,
    summary: 'Buys on the cheaper exchange and sells on the dearer one, when the gap pays.',
    howItWorks:
      'Compares BTC in KRW on Bithumb and Upbit and acts only when the difference clears 0.6%, comfortably above the roughly 0.2% both legs cost together. Korean venues drift from the global price often enough that this is the textbook example.',
    whenItLosesMoney:
      'Both legs are charged, so a gap under about 0.2% is a loss even when it looks like free money -- and this app reports it as a loss rather than rounding it up to zero. Real execution also needs funds already sitting on both exchanges; moving them takes long enough that the gap is usually gone. Paper only in this app.',
    needsReferencePrice: false,
    paperOnly: true,
    keepPosition: false,
    buildParams: () => ({
      buyingMarket: { exchange: BITHUMB.exchange, symbol: BITHUMB.symbol, baseAsset: BITHUMB.baseAsset, quoteAsset: BITHUMB.quoteAsset },
      sellingMarket: { exchange: UPBIT.exchange, symbol: UPBIT.symbol, baseAsset: UPBIT.baseAsset, quoteAsset: UPBIT.quoteAsset },
      orderAmountQuote: 300,
      minProfitabilityPct: 0.6
    })
  }
]

export interface StarterPack {
  id: string
  name: string
  summary: string
  /** Why these belong together, and what the controller around them is watching for. */
  rationale: string
  presetIds: string[]
  riskControls: ControllerRiskControls
}

// A Controller supervises a group of executors and stops the whole group when the aggregate goes
// wrong -- so these packs are grouped by what a shared stop actually means. The percentages read
// against the group's total allocated capital, not against its P&L (see ControllerScheduler).
export const STARTER_PACKS: StarterPack[] = [
  {
    id: 'pack-accumulation',
    name: 'Accumulation Desk',
    summary: 'Two ways of buying in gradually, under one shared stop.',
    rationale:
      'Both of these only ever build a position, so the risk that matters is the whole group being underwater at once. The stop is set wide at 10% because these strategies are meant to sit through ordinary dips -- a tight stop here would cut them off exactly when they are doing their job.',
    presetIds: ['twap-accumulate', 'dca-dip-ladder'],
    riskControls: { globalStopLossPct: 10, globalTakeProfitPct: 15, maxDrawdownPct: 12 }
  },
  {
    id: 'pack-directional',
    name: 'Directional Desk',
    summary: 'One trend trade and one range trade, which fail in opposite conditions.',
    rationale:
      'Deliberately paired: the Triple Barrier trade wants a market that moves, the Range Grid wants one that does not. Whatever the market is doing, one of them is in the wrong conditions -- so the group stop is tighter at 8%, because you are looking for the pair to come out roughly flat, not for both to win.',
    presetIds: ['position-triple-barrier', 'grid-range'],
    riskControls: { globalStopLossPct: 8, globalTakeProfitPct: 12, maxDrawdownPct: 10 }
  },
  {
    id: 'pack-spread',
    name: 'Spread Desk (paper only)',
    summary: 'The three strategies that earn from price differences rather than direction.',
    rationale:
      'None of these can run live in this app, so this pack is for watching how the strategies behave rather than for making money. Its 5% stop is the tightest of the three because a spread strategy down 5% means its central assumption has broken, not that it is having a bad week.',
    presetIds: ['pure-market-making', 'xemm-korea', 'arbitrage-korea'],
    riskControls: { globalStopLossPct: 5, globalTakeProfitPct: 8, maxDrawdownPct: 6 }
  }
]

export function findPreset(id: string): StarterPreset | undefined {
  return STARTER_PRESETS.find((p) => p.id === id)
}

/** Turns a preset into a real executor. Always paper: nothing here has been proven against real
 * money, and several of these types cannot go live in this app at all. */
export function buildPresetExecutor(preset: StarterPreset, opts: { referencePrice: number; now: number }): ExecutorConfig {
  // A grid built from a missing price would still typecheck and still simulate -- it would just
  // sit at bounds of 0 and never trade, which looks identical to a strategy patiently waiting.
  // Refusing loudly is the only way that does not become a silent dud on someone's dashboard.
  if (preset.needsReferencePrice && !(opts.referencePrice > 0)) {
    throw new Error(`${preset.name} needs the current ${preset.symbol} price to place its levels, and none was available.`)
  }

  return {
    id: crypto.randomUUID(),
    name: preset.name,
    type: preset.type,
    exchange: preset.exchange,
    symbol: preset.symbol,
    baseAsset: preset.baseAsset,
    quoteAsset: preset.quoteAsset,
    createdAt: opts.now,
    status: 'active',
    stoppedAt: null,
    keepPosition: preset.keepPosition,
    mode: 'paper',
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: preset.buildParams(opts.referencePrice)
  } as ExecutorConfig
}

/** Builds a pack's executors plus the one controller supervising them. The controller's
 * executorIds are the ids just generated, so the group arrives already wired up instead of
 * leaving the user to attach them by hand. */
export function buildStarterPack(
  pack: StarterPack,
  opts: { referencePrice: number; now: number }
): { executors: ExecutorConfig[]; controller: ControllerConfig } {
  const executors = pack.presetIds
    .map((id) => findPreset(id))
    .filter((p): p is StarterPreset => p !== undefined)
    .map((p) => buildPresetExecutor(p, opts))

  return {
    executors,
    controller: {
      id: crypto.randomUUID(),
      name: pack.name,
      executorIds: executors.map((e) => e.id),
      riskControls: pack.riskControls,
      status: 'active',
      createdAt: opts.now
    }
  }
}
