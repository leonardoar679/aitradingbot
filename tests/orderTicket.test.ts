import { describe, it, expect } from 'vitest'
import { describeTicketProblem } from '../src/trade/orderTicket'

const market = (amountRaw: string, lastPrice: number | null = 75000) =>
  describeTicketProblem({ amountRaw, type: 'market' as const, limitPriceRaw: '', lastPrice })
const limit = (amountRaw: string, limitPriceRaw: string) =>
  describeTicketProblem({ amountRaw, type: 'limit' as const, limitPriceRaw, lastPrice: 75000 })

describe('describeTicketProblem', () => {
  it('allows a well-formed market order', () => {
    expect(market('0.01')).toBeNull()
  })

  it('allows a well-formed limit order', () => {
    expect(limit('0.01', '60000')).toBeNull()
  })

  it('asks for an amount before anything else', () => {
    expect(market('')).toBe('Enter an amount to trade.')
    expect(market('   ')).toBe('Enter an amount to trade.')
  })

  it('rejects zero and negative amounts', () => {
    expect(market('0')).toContain('greater than 0')
    expect(market('-1')).toContain('greater than 0')
  })

  // Number('1e999') is Infinity and passes a bare `> 0`, and "1e999" is typeable into a number
  // input. Same mistake that switched off a real risk limit elsewhere in this app.
  it('rejects an infinite amount', () => {
    expect(market('1e999')).toBe('That amount is not a usable number.')
  })

  it('rejects an unparseable amount', () => {
    expect(market('abc')).toBe('That amount is not a usable number.')
  })

  it('asks for a limit price only on a limit order', () => {
    expect(limit('0.01', '')).toBe('Enter a limit price.')
    expect(market('0.01', 75000)).toBeNull()
  })

  it('rejects a non-finite or non-positive limit price', () => {
    expect(limit('0.01', '1e999')).toContain('not a usable number')
    expect(limit('0.01', '0')).toContain('greater than 0')
    expect(limit('0.01', '-5')).toContain('greater than 0')
  })

  // A market order has nothing to fill against until the price arrives, which previously showed
  // as a greyed-out button with no reason.
  it('explains a missing live price rather than just refusing', () => {
    const msg = market('0.01', null)
    expect(msg).toContain('Waiting for a live price')
    expect(msg).toContain('market order')
  })

  it('does not block a limit order on a missing live price', () => {
    expect(describeTicketProblem({ amountRaw: '0.01', type: 'limit', limitPriceRaw: '60000', lastPrice: null })).toBeNull()
  })

  it('rejects a live price that is not usable', () => {
    expect(market('0.01', 0)).toContain('not usable')
    expect(market('0.01', NaN)).toContain('not usable')
  })
})
