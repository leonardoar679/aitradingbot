// A HYPERLIQUID TRADER'S RECORD, READ (V8 Stage 6, 26 October 2026). Hyperliquid's public info API gives any address's
// fills -- each with its price, size, side, the position before it, the profit it closed and its fee -- the funding it
// paid or was paid, its deposits and withdrawals, its open positions and its account value's history, keyless. What it
// answered is read here into the app's own shapes, every field checked, and anything not in its shape dropped. Fills are
// VERIFIED: the venue's own record of the address. Pure: the main process fetches (electron/services/traderService.ts).

/** How a trade on file came to be known: Hyperliquid's own fills, an OKX lead trader's reported results, the app's own
 * reconstruction, or a file a person brought. */
export type TradeLabel = 'VERIFIED' | 'REPORTED' | 'ESTIMATED' | 'UNVERIFIABLE'

export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info'

/** One fill of a trader's, as Hyperliquid recorded it. Times in milliseconds, as the venue gives them. */
export interface TraderFill {
  coin: string
  timeMs: number
  side: 'buy' | 'sell'
  px: number
  sz: number
  /** The position in the coin before this fill, signed: long positive. */
  startPosition: number
  /** Hyperliquid's own word for it: "Open Long", "Close Short", "Long > Short", "Buy"... */
  dir: string
  /** The profit this fill closed, before its fee, in USDC. */
  closedPnl: number
  /** The fee paid, in feeToken; negative where it was a maker's rebate. */
  fee: number
  feeToken: string
  /** Taker: the fill crossed the book. */
  crossed: boolean
  tid: number
  oid: number
  label: 'VERIFIED'
}

/** A funding payment: negative where the trader paid. */
export interface FundingPayment {
  timeMs: number
  coin: string
  usdc: number
  szi: number
  rate: number
}

/** A movement of money in or out of the account that is not a trade's: a deposit, a withdrawal, a transfer. */
export interface LedgerUpdate {
  timeMs: number
  type: string
  /** Into the account positive, out negative; null where the update moves no USDC the record says. */
  usdc: number | null
}

/** An open position as Hyperliquid reports it now. */
export interface OpenPosition {
  coin: string
  /** Signed: long positive. */
  size: number
  entryPx: number
  positionValue: number
  unrealizedPnl: number
  leverage: { type: string; value: number } | null
  liquidationPx: number | null
  marginUsed: number
  fundingSinceOpen: number | null
}

export interface AccountState {
  atMs: number
  accountValue: number
  positions: OpenPosition[]
}

export interface AccountValuePoint {
  timeMs: number
  value: number
}

const num = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}
const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/** A fill read; null for one not in its shape. */
export function hyperliquidFillOf(raw: unknown): TraderFill | null {
  const fill = record(raw)
  if (fill === null) return null
  const px = num(fill.px)
  const sz = num(fill.sz)
  const timeMs = num(fill.time)
  const startPosition = num(fill.startPosition)
  const closedPnl = num(fill.closedPnl)
  const fee = num(fill.fee)
  const tid = num(fill.tid)
  const oid = num(fill.oid)
  if (typeof fill.coin !== 'string' || fill.coin === '' || (fill.side !== 'B' && fill.side !== 'A')) return null
  if (px === null || !(px > 0) || sz === null || !(sz > 0) || timeMs === null || startPosition === null || closedPnl === null || fee === null || tid === null || oid === null) return null
  return {
    coin: fill.coin,
    timeMs,
    side: fill.side === 'B' ? 'buy' : 'sell',
    px,
    sz,
    startPosition,
    dir: typeof fill.dir === 'string' ? fill.dir : '',
    closedPnl,
    fee,
    feeToken: typeof fill.feeToken === 'string' ? fill.feeToken : 'USDC',
    crossed: fill.crossed === true,
    tid,
    oid,
    label: 'VERIFIED'
  }
}

/** A funding payment read; null for an update that is not one. */
export function hyperliquidFundingOf(raw: unknown): FundingPayment | null {
  const update = record(raw)
  const delta = record(update?.delta)
  if (update === null || delta === null || delta.type !== 'funding' || typeof delta.coin !== 'string') return null
  const timeMs = num(update.time)
  const usdc = num(delta.usdc)
  const szi = num(delta.szi)
  const rate = num(delta.fundingRate)
  if (timeMs === null || usdc === null || szi === null || rate === null) return null
  return { timeMs, coin: delta.coin, usdc, szi, rate }
}

/** Ledger kinds that bring money into the trading account, and that take it out; any other kind is kept with the amount
 * the record gives, its direction unsaid. */
const INTO = new Set(['deposit', 'vaultWithdraw'])
const OUT_OF = new Set(['withdraw', 'vaultDeposit'])

/** A ledger update read: a deposit in, a withdrawal out, any other kind as the record gives it. */
export function hyperliquidLedgerOf(raw: unknown): LedgerUpdate | null {
  const update = record(raw)
  const delta = record(update?.delta)
  if (update === null || delta === null || typeof delta.type !== 'string') return null
  const timeMs = num(update.time)
  if (timeMs === null) return null
  const amount = num(delta.usdc)
  const usdc = amount === null ? null : INTO.has(delta.type) ? Math.abs(amount) : OUT_OF.has(delta.type) ? -Math.abs(amount) : amount
  return { timeMs, type: delta.type, usdc }
}

/** The account as Hyperliquid reports it now: its perpetuals' value and every open position; null for an answer not in
 * its shape. */
export function hyperliquidStateOf(raw: unknown): AccountState | null {
  const state = record(raw)
  const summary = record(state?.marginSummary)
  if (state === null || summary === null || !Array.isArray(state.assetPositions)) return null
  const accountValue = num(summary.accountValue)
  const atMs = num(state.time)
  if (accountValue === null || atMs === null) return null
  const positions: OpenPosition[] = []
  for (const entry of state.assetPositions) {
    const position = record(record(entry)?.position)
    if (position === null || typeof position.coin !== 'string') continue
    const size = num(position.szi)
    const entryPx = num(position.entryPx)
    const positionValue = num(position.positionValue)
    const unrealizedPnl = num(position.unrealizedPnl)
    const marginUsed = num(position.marginUsed)
    if (size === null || size === 0 || entryPx === null || positionValue === null || unrealizedPnl === null || marginUsed === null) continue
    const leverage = record(position.leverage)
    const leverageValue = num(leverage?.value)
    positions.push({
      coin: position.coin,
      size,
      entryPx,
      positionValue,
      unrealizedPnl,
      leverage: leverage !== null && typeof leverage.type === 'string' && leverageValue !== null ? { type: leverage.type, value: leverageValue } : null,
      liquidationPx: num(position.liquidationPx),
      marginUsed,
      fundingSinceOpen: num(record(position.cumFunding)?.sinceOpen)
    })
  }
  return { atMs, accountValue, positions }
}

/** The account's value through time, every period Hyperliquid's portfolio gives merged: finer near now, coarser back. */
export function hyperliquidAccountValuesOf(raw: unknown): AccountValuePoint[] {
  if (!Array.isArray(raw)) return []
  const byTime = new Map<number, number>()
  for (const entry of raw) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || entry[0].startsWith('perp')) continue
    const history = record(entry[1])?.accountValueHistory
    if (!Array.isArray(history)) continue
    for (const point of history) {
      if (!Array.isArray(point)) continue
      const timeMs = num(point[0])
      const value = num(point[1])
      if (timeMs !== null && value !== null) byTime.set(timeMs, value)
    }
  }
  return [...byTime.entries()].map(([timeMs, value]) => ({ timeMs, value })).sort((a, b) => a.timeMs - b.timeMs)
}

/** A fill of a spot pair rather than a perpetual: Hyperliquid names spot pairs "@107" or "PURR/USDC". */
export const isSpotCoin = (coin: string): boolean => coin.startsWith('@') || coin.includes('/')

/** The perpetuals a Hyperliquid coin may be on Binance's or Bitget's books, in the order tried: "kPEPE" is a thousand
 * PEPE, which a venue writes 1000PEPEUSDT; a builder's market ("xyz:XYZ100") and a spot pair have none. */
export function perpCandidatesOf(coin: string): string[] {
  if (isSpotCoin(coin) || coin.includes(':') || !/^k?[A-Za-z0-9]+$/.test(coin)) return []
  if (/^k[A-Z0-9]/.test(coin)) {
    const base = coin.slice(1).toUpperCase()
    return [`1000${base}USDT`, `${base}USDT`, `1000000${base}USDT`]
  }
  return [`${coin.toUpperCase()}USDT`, `1000${coin.toUpperCase()}USDT`]
}

/** The account's value at a moment: the last point at or before it; null before the first. */
export function accountValueAt(points: readonly AccountValuePoint[], timeMs: number): number | null {
  let low = 0
  let high = points.length - 1
  let found: number | null = null
  while (low <= high) {
    const mid = (low + high) >> 1
    if (points[mid].timeMs <= timeMs) {
      found = points[mid].value
      low = mid + 1
    } else high = mid - 1
  }
  return found
}
