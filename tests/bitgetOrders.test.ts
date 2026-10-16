import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetBitgetRules, stepOfDecimals } from '../electron/services/exchanges/bitget'
import {
  BITGET_ORDER_PATHS,
  MARKETABLE_CAP,
  binanceStatusOf,
  cancelOrder,
  ceilToStep,
  clientOidOf,
  commissionsOf,
  fetchOpenOrders,
  floorToStep,
  openOrderOf,
  orderResultOf,
  placeLimitOrder,
  placeMarketBuy,
  placeMarketOrder,
  placeMarketSellByQuantity,
  queryOrder,
  type BitgetRequest,
  type BitgetSend
} from '../electron/services/exchanges/bitgetOrders'

// BITGET'S SPOT ORDERS, THEIR SHAPE (electron/services/exchanges/bitgetOrders.ts; V7.1 Stage 8): a market
// order as a marketable limit order that fills or dies, sized by the book and the pair's steps; the
// answers read into the ledgers' shape; a placement that timed out asked about by its client id. The
// signer is faked: what was sent is kept, and the answers are the unified account's shapes as its SDKs
// give them.

/** The instrument and the book the public reads answer with: BTCUSDT at two price decimals and six
 * quantity decimals, the ask at 82,041.72 and the bid at 82,041.71. */
beforeEach(() => {
  resetBitgetRules()
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', (url: string) => {
    const u = String(url)
    if (u.includes('/api/v3/market/instruments')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: '00000', msg: 'success', data: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'online', pricePrecision: '2', quantityPrecision: '6', minOrderAmount: '1', minOrderQty: '0' }] }) })
    }
    if (u.includes('/api/v3/market/orderbook')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: '00000', msg: 'success', data: { a: [[82041.72, 0.17], [82043.22, 0.05]], b: [[82041.71, 0.31], [82041.0, 0.1]], ts: '1792125772115' } }) })
    }
    return Promise.reject(new Error(`unexpected ${u}`))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A fake signer: every request kept, answered by `answers` in order, or by a function of the request. */
function fakeSend(answers: (unknown | ((request: BitgetRequest) => unknown))[]): { send: BitgetSend; sent: BitgetRequest[] } {
  const sent: BitgetRequest[] = []
  const send: BitgetSend = async <T,>(request: BitgetRequest): Promise<T> => {
    sent.push(request)
    const next = answers.shift()
    if (next === undefined) throw new Error(`no answer for ${request.what}`)
    const answer = typeof next === 'function' ? (next as (request: BitgetRequest) => unknown)(request) : next
    if (answer instanceof Error) throw answer
    return answer as T
  }
  return { send, sent }
}

const filled = (orderId: string, qty: string, avg: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  orderId,
  clientOid: 'c1',
  symbol: 'BTCUSDT',
  side: 'buy',
  orderType: 'limit',
  price: '82205.81',
  qty,
  cumExecQty: qty,
  cumExecValue: String(Number(qty) * Number(avg)),
  avgPrice: avg,
  orderStatus: 'filled',
  feeDetail: [{ feeCoin: 'BTC', fee: '-0.000001' }],
  createdTime: '1792125772389',
  ...extra
})

describe("an order's answer, read", () => {
  it("maps Bitget's status onto the words the ledgers resolve by", () => {
    expect(binanceStatusOf('filled')).toBe('FILLED')
    expect(binanceStatusOf('cancelled')).toBe('CANCELED')
    expect(binanceStatusOf('partially_filled')).toBe('PARTIALLY_FILLED')
    expect(binanceStatusOf('live')).toBe('NEW')
    expect(binanceStatusOf('new')).toBe('NEW')
    expect(binanceStatusOf('odd')).toBe('ODD')
  })

  it('reads the fill, the average price from the value where none is given, the fees by coin as positive amounts', () => {
    expect(orderResultOf(filled('9', '0.001', '82050') as never)).toEqual({ orderId: '9', status: 'FILLED', filledQty: 0.001, avgFillPrice: 82050, cummulativeQuoteQty: 82.05, commissions: { BTC: 0.000001 } })
    expect(orderResultOf({ orderId: 10, symbol: 'BTCUSDT', side: 'sell', cumExecQty: '2', cumExecValue: '200', orderStatus: 'partially_filled' } as never)).toMatchObject({ orderId: '10', status: 'PARTIALLY_FILLED', filledQty: 2, avgFillPrice: 100, cummulativeQuoteQty: 200, commissions: {} })
    expect(orderResultOf({ orderId: '11', symbol: 'BTCUSDT', side: 'buy', orderStatus: 'live' } as never)).toMatchObject({ status: 'NEW', filledQty: 0, avgFillPrice: 0, cummulativeQuoteQty: 0 })
    expect(commissionsOf([{ feeCoin: 'USDT', fee: '-0.1' }, { feeCoin: 'USDT', fee: '-0.2' }, { feeCoin: 'BNB', fee: '0' }, { feeCoin: 'X', fee: 'n/a' }])).toEqual({ USDT: 0.30000000000000004 })
    expect(commissionsOf(null)).toEqual({})
  })

  it('reads a resting order as the reconciliation sees it', () => {
    expect(openOrderOf({ orderId: '7', symbol: 'ETHUSDT', side: 'Sell', orderStatus: 'live', qty: '1.5', cumExecQty: '0.5', price: '2500', createdTime: '1792125772000' })).toEqual({ orderId: '7', symbol: 'ETHUSDT', side: 'sell', status: 'NEW', origQty: 1.5, executedQty: 0.5, price: 2500, placedAt: 1792125772 })
  })

  it('floors onto a step and never rounds up, the step read from the decimals', () => {
    expect(stepOfDecimals(6)).toBe('0.000001')
    expect(stepOfDecimals(0)).toBe('1')
    expect(stepOfDecimals(2)).toBe('0.01')
    expect(floorToStep(0.3, '0.1')).toBe('0.3')
    expect(floorToStep(28.999999999999996, '1')).toBe('29')
    expect(floorToStep(0.0012349, '0.000001')).toBe('0.001234')
    expect(floorToStep(1.999, '1')).toBe('1')
    expect(ceilToStep(82205.8044, '0.01')).toBe('82205.81')
    expect(ceilToStep(82205.8, '0.01')).toBe('82205.80')
    expect(clientOidOf(1792125772389)).toMatch(/^ts[0-9a-z]{8}[0-9a-z]{8}$/)
    expect(clientOidOf()).not.toBe(clientOidOf())
    expect(MARKETABLE_CAP).toBe(0.002)
    expect(BITGET_ORDER_PATHS).toEqual({ place: '/api/v3/trade/place-order', cancel: '/api/v3/trade/cancel-order', detail: '/api/v3/trade/order-info', open: '/api/v3/trade/unfilled-orders', fills: '/api/v3/trade/fills' })
  })
})

describe('a market buy', () => {
  it('is a limit order a fifth of a percent through the ask, immediate or cancel, sized in the base coin by the pair\'s steps, read back once the match is written', async () => {
    const { send, sent } = fakeSend([{ orderId: '9', clientOid: 'c' }, filled('9', '0.001215', '82041.72')])
    const result = await placeMarketBuy(send, 'btcusdt', 100)
    expect(sent[0]).toMatchObject({ method: 'POST', path: '/api/v3/trade/place-order' })
    const body = sent[0].body as Record<string, string>
    // 82,041.72 * 1.002 = 82,205.80344, up to the tick: 82,205.81; 100 / 82,205.81 = 0.0012164 BTC, down to the step.
    expect(body).toMatchObject({ category: 'SPOT', symbol: 'BTCUSDT', side: 'buy', orderType: 'limit', price: '82205.81', qty: '0.001216', timeInForce: 'ioc' })
    expect(body.clientOid).toMatch(/^ts/)
    expect(sent[1]).toMatchObject({ method: 'GET', path: '/api/v3/trade/order-info', query: { category: 'SPOT', orderId: '9' } })
    expect(result).toMatchObject({ orderId: '9', status: 'FILLED', filledQty: 0.001215, avgFillPrice: 82041.72 })
  })

  it('reads an immediate order again while the exchange still shows it open, a few times, then takes what it says', async () => {
    const { send, sent } = fakeSend([{ orderId: '9', clientOid: 'c' }, { orderId: '9', symbol: 'BTCUSDT', side: 'buy', orderStatus: 'live' }, { orderId: '9', symbol: 'BTCUSDT', side: 'buy', orderStatus: 'new' }, filled('9', '0.001216', '82041.72')])
    const result = await placeMarketBuy(send, 'BTCUSDT', 100)
    expect(sent).toHaveLength(4)
    expect(result.filledQty).toBe(0.001216)
  })

  it('refuses where nothing filled within the cap, where the amount is under the pair\'s minimum, and where it buys less than a step', async () => {
    const { send } = fakeSend([{ orderId: '9', clientOid: 'c' }, { orderId: '9', symbol: 'BTCUSDT', side: 'buy', orderStatus: 'cancelled', cumExecQty: '0' }, { orderId: '9', symbol: 'BTCUSDT', side: 'buy', orderStatus: 'cancelled', cumExecQty: '0' }, { orderId: '9', symbol: 'BTCUSDT', side: 'buy', orderStatus: 'cancelled', cumExecQty: '0' }, { orderId: '9', symbol: 'BTCUSDT', side: 'buy', orderStatus: 'cancelled', cumExecQty: '0' }])
    await expect(placeMarketBuy(send, 'BTCUSDT', 100)).rejects.toThrow('The BTCUSDT buy did not fill within 0.2% of the book (CANCELED): nothing was bought.')
    await expect(placeMarketBuy(fakeSend([]).send, 'BTCUSDT', 0.5)).rejects.toThrow('Bitget will not accept a BTCUSDT order below 1 in the quote currency; 0.5 is less.')
    await expect(placeMarketBuy(fakeSend([]).send, 'BTCUSDT', 0)).rejects.toThrow('A quote amount of 0 is not an order this app will send to an exchange.')
  })

  it('asks about a placement that timed out by its client id before giving it up, so that one order is never placed twice', async () => {
    const { send, sent } = fakeSend([new Error('fetch failed'), (request) => filled('77', '0.001216', '82041.72', { clientOid: (request.query as Record<string, string>).clientOid })])
    const result = await placeMarketBuy(send, 'BTCUSDT', 100)
    expect(sent[1]).toMatchObject({ method: 'GET', path: '/api/v3/trade/order-info' })
    expect((sent[1].query as Record<string, string>).clientOid).toBe((sent[0].body as Record<string, string>).clientOid)
    expect(result.orderId).toBe('77')
    // Not found by the client id either: the placement's own failure is the answer.
    const gone = fakeSend([new Error('fetch failed'), new Error('not found')])
    await expect(placeMarketBuy(gone.send, 'BTCUSDT', 100)).rejects.toThrow('fetch failed')
  })

  it('sells a quantity a fifth of a percent under the bid, immediate or cancel, and a quote amount as the quantity it is worth at the bid', async () => {
    const sale = fakeSend([{ orderId: '12', clientOid: 'c' }, filled('12', '0.5', '82041.71', { side: 'sell' })])
    await placeMarketSellByQuantity(sale.send, 'BTCUSDT', 0.5000004)
    // 82,041.71 * 0.998 = 81,877.62658, down to the tick.
    expect(sale.sent[0].body).toMatchObject({ side: 'sell', qty: '0.500000', price: '81877.62', timeInForce: 'ioc' })
    const worth = fakeSend([{ orderId: '13', clientOid: 'c' }, filled('13', '0.001218', '82041.71', { side: 'sell' })])
    await placeMarketOrder(worth.send, 'BTCUSDT', 'SELL', 100)
    // 100 / 82,041.71 = 0.0012189 BTC, down to the step.
    expect(worth.sent[0].body).toMatchObject({ side: 'sell', qty: '0.001218' })
    await expect(placeMarketSellByQuantity(fakeSend([]).send, 'BTCUSDT', 0.0000001)).rejects.toThrow("Position size 1e-7 is below BTCUSDT's minimum tradable increment (0.000001) and cannot be sold.")
  })
})

describe('a resting order, a query and a cancel', () => {
  it('rests good till cancelled at the price and quantity floored onto their steps', async () => {
    const { send, sent } = fakeSend([{ orderId: '20', clientOid: 'c' }, { orderId: '20', symbol: 'BTCUSDT', side: 'buy', orderStatus: 'live', qty: '0.0015', price: '80000.00' }])
    const result = await placeLimitOrder(send, 'BTCUSDT', 'buy', 0.00150009, 80000.009)
    expect(sent[0].body).toMatchObject({ category: 'SPOT', symbol: 'BTCUSDT', side: 'buy', orderType: 'limit', qty: '0.001500', price: '80000.00', timeInForce: 'gtc' })
    expect(result).toMatchObject({ orderId: '20', status: 'NEW', filledQty: 0 })
    await expect(placeLimitOrder(fakeSend([]).send, 'BTCUSDT', 'buy', 0.000001, 0.5)).rejects.toThrow('Bitget will not accept a BTCUSDT order below 1 in the quote currency.')
  })

  it('asks about an order by its id, taking an answer given as a list of one', async () => {
    const { send } = fakeSend([[filled('21', '0.001', '82000')]])
    expect(await queryOrder(send, 21)).toMatchObject({ orderId: '21', status: 'FILLED', filledQty: 0.001 })
    await expect(queryOrder(fakeSend([[]]).send, '22')).rejects.toThrow('Bitget returned no order for 22')
  })

  it('cancels and reads what had filled; an order already done is read as it is rather than refused', async () => {
    const { send, sent } = fakeSend([{ orderId: '30', clientOid: 'c' }, { orderId: '30', symbol: 'BTCUSDT', side: 'buy', orderStatus: 'cancelled', cumExecQty: '0.0004', cumExecValue: '32.8', avgPrice: '82000' }])
    const result = await cancelOrder(send, 'btcusdt', '30')
    expect(sent[0]).toMatchObject({ method: 'POST', path: '/api/v3/trade/cancel-order', body: { category: 'SPOT', symbol: 'BTCUSDT', orderId: '30' } })
    expect(result).toMatchObject({ orderId: '30', status: 'CANCELED', filledQty: 0.0004, avgFillPrice: 82000 })
    const done = fakeSend([new Error('order is already filled'), filled('31', '0.001', '82000')])
    expect(await cancelOrder(done.send, 'BTCUSDT', '31')).toMatchObject({ status: 'FILLED', filledQty: 0.001 })
    const resting = fakeSend([new Error('temporary'), { orderId: '32', symbol: 'BTCUSDT', side: 'buy', orderStatus: 'live' }])
    await expect(cancelOrder(resting.send, 'BTCUSDT', '32')).rejects.toThrow('temporary')
  })

  it('lists the resting orders from the list the exchange gives, or a bare list', async () => {
    const { send, sent } = fakeSend([{ list: [{ orderId: '7', symbol: 'ETHUSDT', side: 'buy', orderStatus: 'live', qty: '1', cumExecQty: '0', price: '2500', createdTime: '1792125772000' }], cursor: '' }])
    expect(await fetchOpenOrders(send)).toEqual([{ orderId: '7', symbol: 'ETHUSDT', side: 'buy', status: 'NEW', origQty: 1, executedQty: 0, price: 2500, placedAt: 1792125772 }])
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/api/v3/trade/unfilled-orders', query: { category: 'SPOT' } })
    expect(await fetchOpenOrders(fakeSend([[]]).send)).toEqual([])
  })
})
