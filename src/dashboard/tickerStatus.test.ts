import { describe, it, expect } from 'vitest'
import { describeTickerProblem } from './tickerStatus'

describe('describeTickerProblem', () => {
  it('says nothing while the first load is still in flight', () => {
    expect(describeTickerProblem({ hasTicker: false, lastError: null, symbol: 'BTCUSDT' })).toBeNull()
  })

  it('says nothing once a price has arrived', () => {
    expect(describeTickerProblem({ hasTicker: true, lastError: null, symbol: 'BTCUSDT' })).toBeNull()
  })

  it('stays quiet when a refresh fails but a price is already on screen', () => {
    // Blanking a good row over one failed poll would be worse than showing a slightly old figure.
    expect(describeTickerProblem({ hasTicker: true, lastError: 'network down', symbol: 'BTCUSDT' })).toBeNull()
  })

  it('explains the failure when there is nothing at all to show', () => {
    const message = describeTickerProblem({
      hasTicker: false,
      lastError: 'all Binance endpoints unreachable from this location',
      symbol: 'BTCUSDT'
    })
    expect(message).not.toBeNull()
    expect(message).toContain('BTCUSDT')
    expect(message).toContain('all Binance endpoints unreachable from this location')
  })

  it('warns that the chart below is a different connection and is not the current price', () => {
    // This is the whole point: the observed failure left the header on em dashes while the chart
    // kept ticking the same symbol, so a newbie reads the moving chart as proof nothing is wrong.
    const message = describeTickerProblem({ hasTicker: false, lastError: 'boom', symbol: 'ETHUSDT' })
    expect(message).toContain('chart below')
    expect(message).toContain('separate connection')
  })

  it('promises a retry so the row does not read as permanently dead', () => {
    const message = describeTickerProblem({ hasTicker: false, lastError: 'boom', symbol: 'ETHUSDT' })
    expect(message).toContain('Retrying automatically')
  })
})
