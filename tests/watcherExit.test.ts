import { describe, expect, it } from 'vitest'
import { describeIncompleteExit } from '../electron/services/watcherExit'
import type { LivePosition } from '../shared/ipc'

// A watcher fires one market sell for the whole position and then stops watching. That is only
// safe if the sell actually closed the position -- and a market order can fill partially. The
// old code deactivated the watcher as soon as the order had been SENT, so a partial fill left
// real exposure open with its stop-loss and take-profit switched off and nothing saying so.

function position(overrides: Partial<LivePosition> = {}): LivePosition {
  return {
    id: 'p1',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: 0,
    avgCost: 60_000,
    openedAt: 1_700_000_000,
    closedAt: 1_700_090_000,
    exitPrice: 61_000,
    realizedPnl: 9.5,
    ...overrides
  }
}

describe('deciding whether a watcher may stand down', () => {
  it('stands down on a position that is closed and priced', () => {
    expect(describeIncompleteExit(position(), 'BTCUSDT')).toBeNull()
  })

  it('keeps watching when the sell only partially filled', () => {
    // The case that matters: the exchange took some of it, the rest is still held.
    const message = describeIncompleteExit(position({ qty: 0.004, closedAt: null, exitPrice: null }), 'BTCUSDT')

    expect(message).toContain('only partially filled')
    expect(message).toContain('0.004 is still open')
    expect(message).toContain('will be retried')
  })

  it('keeps watching when quantity is left even though the ledger stamped it closed', () => {
    // Belt and braces: either signal alone is enough to refuse to stand down.
    expect(describeIncompleteExit(position({ qty: 0.01 }), 'BTCUSDT')).toContain('still open')
  })

  it('refuses to stand down on a position the ledger never marked closed', () => {
    // Both signals are required, not either. livePositionsService stamps closedAt in the same
    // step that zeroes the quantity, so a zero-quantity position with no closedAt means the
    // ledger did not agree the position was finished -- and this check sits across a service
    // boundary, so it does not get to assume the other side's invariant held.
    expect(describeIncompleteExit(position({ qty: 0, closedAt: null }), 'BTCUSDT')).not.toBeNull()
  })

  it('treats a dust remainder the ledger calls flat as closed', () => {
    // livePositionsService zeroes anything at or below 1e-9, so this must not be read as an
    // unfinished exit and retried forever against a size no exchange will trade.
    expect(describeIncompleteExit(position({ qty: 1e-10 }), 'BTCUSDT')).toBeNull()
  })

  it('keeps watching when the position cannot be read back at all', () => {
    const message = describeIncompleteExit(null, 'ETHUSDT')

    expect(message).toContain('could not be read back')
    expect(message).toContain('ETHUSDT')
  })

  it('does not report an exit the exchange never priced', () => {
    // Closed, but with nothing to put on the card. Reporting it would mean inventing a fill
    // price and a P&L to match.
    expect(describeIncompleteExit(position({ exitPrice: null }), 'BTCUSDT')).toContain('did not report a fill price')
    expect(describeIncompleteExit(position({ realizedPnl: null }), 'BTCUSDT')).toContain('did not report a fill price')
  })

  it('names the symbol in every refusal, since the message is what the user acts on', () => {
    for (const p of [null, position({ qty: 0.5, closedAt: null }), position({ exitPrice: null })]) {
      expect(describeIncompleteExit(p, 'SOLUSDT')).toContain('SOLUSDT')
    }
  })
})
