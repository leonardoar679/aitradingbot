import { beforeEach, describe, expect, it, vi } from 'vitest'
import { quoteStepFor } from '../electron/services/exchanges/binanceTrading'

// A quote amount is very often a division: a 10 USDT TWAP over three slices is
// 3.3333333333333335, and String() of that is sixteen decimal places. Binance rejects an
// over-precise quoteOrderQty outright (-1111) rather than rounding it, so every live TWAP whose
// total did not divide evenly was being sent in a form the exchange would refuse.

describe('the step a quote amount is floored onto', () => {
  it('reads it from the symbol precision', () => {
    expect(quoteStepFor(8)).toBe('0.00000001')
    expect(quoteStepFor(2)).toBe('0.01')
    expect(quoteStepFor(0)).toBe('1')
  })

  it('falls back to eight decimals for anything unusable', () => {
    // toFixed throws on a negative or fractional precision, and a crash inside an order path is
    // a far worse failure than eight decimals.
    for (const bad of [undefined, Number.NaN, -1, 2.5, 99]) {
      expect(quoteStepFor(bad as number | undefined)).toBe('0.00000001')
    }
  })
})

describe('placing a market order sized in quote currency', () => {
  const captured: { url: string; method: string }[] = []
  let exchangeInfo: unknown
  let orderResponse: { ok: boolean; status: number; body: unknown }

  beforeEach(() => {
    captured.length = 0
    exchangeInfo = {
      symbols: [
        {
          quoteAssetPrecision: 8,
          filters: [
            { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001' },
            { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
            { filterType: 'NOTIONAL', minNotional: '1.00000000' }
          ]
        }
      ]
    }
    orderResponse = {
      ok: true,
      status: 200,
      body: { orderId: 7, status: 'FILLED', executedQty: '0.0001', cummulativeQuoteQty: '3.33', fills: [{ price: '33300', qty: '0.0001' }] }
    }
    vi.stubGlobal('fetch', (url: string, init?: { method?: string }) => {
      const u = String(url)
      captured.push({ url: u, method: init?.method ?? 'GET' })
      const reply = (body: unknown, ok = true, status = 200) =>
        Promise.resolve({ ok, status, statusText: 'x', json: () => Promise.resolve(body) })
      // resolveEndpoint probes with a klines request before any signed call is made.
      if (u.includes('/klines')) return reply([[0, '1', '1', '1', '1', '1', 0, '1', 1, '1', '1', '0']])
      if (u.includes('/time')) return reply({ serverTime: Date.now() })
      if (u.includes('/exchangeInfo')) return reply(exchangeInfo)
      return reply(orderResponse.body, orderResponse.ok, orderResponse.status)
    })
  })

  async function place(quoteAmount: number, side: 'BUY' | 'SELL' = 'BUY') {
    vi.resetModules()
    const mod = await import('../electron/services/exchanges/binanceTrading')
    return mod.placeMarketOrder('k', 's', 'BTCUSDT', side, quoteAmount)
  }

  const orderRequest = () => captured.find((c) => c.method === 'POST')

  it('floors a repeating slice amount onto the quote precision', async () => {
    // The bug this test exists for: 10 / 3 reached the exchange as
    // quoteOrderQty=3.3333333333333335 and came back rejected for precision.
    await place(10 / 3)

    expect(orderRequest()?.url).toContain('quoteOrderQty=3.33333333')
    expect(orderRequest()?.url).not.toContain('3.3333333333333335')
  })

  it('never rounds the amount up', async () => {
    // Rounding up spends money the gate never approved, and on a sell it can exceed the balance.
    await place(10 / 3)
    const sent = Number(new URL(orderRequest()!.url).searchParams.get('quoteOrderQty'))

    expect(sent).toBeLessThanOrEqual(10 / 3)
  })

  it('never sends exponential notation', async () => {
    // String(1e-7) is "1e-7", which Binance rejects outright.
    exchangeInfo = { symbols: [{ quoteAssetPrecision: 8, filters: [] }] }
    await place(0.0000001)

    expect(orderRequest()?.url).toContain('quoteOrderQty=0.00000010')
  })

  it('refuses an amount that is not an amount, before anything is sent', async () => {
    for (const bad of [0, -5, Number.NaN]) {
      await expect(place(bad)).rejects.toThrow(/not an order this app will send/)
      expect(orderRequest()).toBeUndefined()
    }
  })

  it('names the exchange minimum rather than letting it come back as a filter failure', async () => {
    // Real BTCUSDT is 5 USDT, so a 10 USDT TWAP split three ways is genuinely unplaceable --
    // and "Filter failure: NOTIONAL" tells someone nothing about what to change.
    exchangeInfo = { symbols: [{ quoteAssetPrecision: 8, filters: [{ filterType: 'NOTIONAL', minNotional: '5.00000000' }] }] }
    await expect(place(10 / 3)).rejects.toThrow(/3.33333333 is below the exchange minimum of 5/)
    expect(orderRequest()).toBeUndefined()
  })

  it('still places the order when the trading rules cannot be read', async () => {
    // This path carries closing sells too. A rules request that fails must never be able to trap
    // someone inside a position -- eight decimals is accepted by every Binance quote asset.
    exchangeInfo = { symbols: [] }
    await place(10 / 3, 'SELL')

    expect(orderRequest()?.url).toContain('quoteOrderQty=3.33333333')
    expect(orderRequest()?.url).toContain('side=SELL')
  })

  it('respects a coarser quote precision when the symbol has one', async () => {
    exchangeInfo = { symbols: [{ quoteAssetPrecision: 2, filters: [{ filterType: 'NOTIONAL', minNotional: '1' }] }] }
    await place(10 / 3)

    expect(orderRequest()?.url).toContain('quoteOrderQty=3.33')
  })
})
