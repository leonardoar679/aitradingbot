import { describe, expect, it } from 'vitest'
import { USER_STREAM_KEEPALIVE_MS, emptyUserStreamState, parseUserStreamFrame, resolvedOrderStatus, userStreamUrl, userStreamWanted } from '../shared/userStream'

// THE USER-DATA STREAM'S ARITHMETIC (shared/userStream.ts; the V5 document, §101-102; V5 Stage 11).

const report = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ e: 'executionReport', E: 1791460800123, s: 'ETHUSDT', S: 'BUY', i: 12345, X: 'FILLED', z: '0.00400000', Z: '10.12000000', L: '2530.00000000', l: '0.00400000', n: '0.00000400', N: 'ETH', ...over })

describe('a frame of the stream', () => {
  it("reads an order's report: the pair, the id, the side, the status, what filled and what it cost, the last execution and its commission", () => {
    expect(parseUserStreamFrame(report())).toEqual({
      kind: 'order',
      symbol: 'ETHUSDT',
      orderId: 12345,
      side: 'buy',
      status: 'FILLED',
      filledQty: 0.004,
      cumulativeQuote: 10.12,
      lastPrice: 2530,
      lastQty: 0.004,
      commission: { asset: 'ETH', amount: 0.000004 },
      eventTime: 1791460800
    })
    // No commission on a report of a resting order; a sell is a sell.
    expect(parseUserStreamFrame(report({ X: 'NEW', z: '0', Z: '0', n: '0', N: null, S: 'SELL', L: '0', l: '0' }))).toMatchObject({ status: 'NEW', side: 'sell', filledQty: 0, commission: null })
  })

  it('reads the balances after a change', () => {
    const frame = JSON.stringify({ e: 'outboundAccountPosition', E: 1791460800123, u: 1791460800100, B: [{ a: 'ETH', f: '0.00400000', l: '0.00000000' }, { a: 'USDT', f: '489.88', l: '10' }] })
    expect(parseUserStreamFrame(frame)).toEqual({ kind: 'balances', rows: [{ asset: 'ETH', free: 0.004, locked: 0 }, { asset: 'USDT', free: 489.88, locked: 10 }], eventTime: 1791460800 })
  })

  it('reads nothing of a deposit, an expiring key, a frame that is not JSON, or a report with a field it cannot read', () => {
    expect(parseUserStreamFrame(JSON.stringify({ e: 'balanceUpdate', E: 1791460800123, a: 'USDT', d: '100' }))).toBeNull()
    expect(parseUserStreamFrame(JSON.stringify({ e: 'listenKeyExpired', E: 1791460800123 }))).toBeNull()
    expect(parseUserStreamFrame('not json')).toBeNull()
    expect(parseUserStreamFrame('[]')).toBeNull()
    expect(parseUserStreamFrame(report({ z: 'lots' }))).toBeNull()
    expect(parseUserStreamFrame(report({ i: undefined }))).toBeNull()
    expect(parseUserStreamFrame(report({ S: 'LONG' }))).toBeNull()
    expect(parseUserStreamFrame(JSON.stringify({ e: 'outboundAccountPosition', E: 1791460800123, B: [{ a: 'ETH', f: 'x', l: '0' }] }))).toBeNull()
  })

  it("reads Binance's status as the ledger's three, and null while the order rests", () => {
    expect(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH', 'NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL'].map(resolvedOrderStatus)).toEqual(['filled', 'cancelled', 'expired', 'expired', 'expired', null, null, null])
  })
})

describe('whether the stream is wanted', () => {
  it('wants a key stored and something to hear: the session armed, an order open, or a position open', () => {
    expect(userStreamWanted({ keyStored: true, armed: true, openOrders: 0, openPositions: 0 })).toBe(true)
    expect(userStreamWanted({ keyStored: true, armed: false, openOrders: 1, openPositions: 0 })).toBe(true)
    expect(userStreamWanted({ keyStored: true, armed: false, openOrders: 0, openPositions: 2 })).toBe(true)
    expect(userStreamWanted({ keyStored: true, armed: false, openOrders: 0, openPositions: 0 })).toBe(false)
    expect(userStreamWanted({ keyStored: false, armed: true, openOrders: 3, openPositions: 3 })).toBe(false)
  })

  it("builds the stream's address from the host's socket base and the key, and from a local server for a check", () => {
    expect(userStreamUrl('wss://stream.binance.com:9443/ws', 'abc')).toBe('wss://stream.binance.com:9443/ws/abc')
    expect(userStreamUrl('wss://stream.binance.com:9443', 'abc')).toBe('wss://stream.binance.com:9443/ws/abc')
    expect(userStreamUrl('ws://127.0.0.1:5555/', 'abc')).toBe('ws://127.0.0.1:5555/ws/abc')
    expect(USER_STREAM_KEEPALIVE_MS).toBe(30 * 60_000)
    expect(emptyUserStreamState()).toEqual({ wanted: false, open: false, connects: 0, drops: 0, lastFrameAt: null, orders: 0, balances: 0, keepAlives: 0, error: null })
  })
})
