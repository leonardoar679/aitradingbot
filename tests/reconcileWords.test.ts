import { describe, expect, it } from 'vitest'
import { describeReconciliation, describeUnknownOrder, type ReconciliationReadout } from '../shared/reconcileLive'
import { describeUserStream, emptyUserStreamState } from '../shared/userStream'

// The words Live Trading and Positions show for the account's own stream and the reconciliation
// (the V5 document, §101-102; 8 October 2026).

const T = Math.floor(Date.parse('2026-10-08T12:00:00Z') / 1000)

const readout = (patch: Partial<ReconciliationReadout> = {}): ReconciliationReadout => ({
  at: T,
  unknownOrders: [],
  discrepancies: [],
  unchecked: [],
  resolvedByCheck: 0,
  keyStored: true,
  error: null,
  ...patch
})

describe('describeReconciliation', () => {
  it('says when nothing has been checked, when there is no key, and when the check failed', () => {
    expect(describeReconciliation(readout({ at: null }), 'Binance')).toEqual({ line: 'Not checked yet: the first look comes within a minute of the start.', tone: 'muted', findings: [] })
    expect(describeReconciliation(readout({ keyStored: false }), 'Binance')).toEqual({ line: 'No Binance key is connected, so there is nothing to check.', tone: 'muted', findings: [] })
    expect(describeReconciliation(readout({ error: 'Binance account request failed: 503' }), 'Binance')).toEqual({
      line: 'Could not check at 12:00 UTC: Binance account request failed: 503',
      tone: 'muted',
      findings: []
    })
  })

  it('says the exchange agrees, with what the check resolved and what it could not read', () => {
    expect(describeReconciliation(readout(), 'Binance')).toEqual({
      line: "Checked at 12:00 UTC: the orders resting on Binance and the account's balances agree with the ledger.",
      tone: 'up',
      findings: []
    })
    expect(describeReconciliation(readout({ resolvedByCheck: 1, unchecked: ['XYZ'] }), 'Binance').line).toBe(
      "Checked at 12:00 UTC: the orders resting on Binance and the account's balances agree with the ledger. 1 order the exchange no longer rested was resolved by the check. XYZ could not be read, so that holding was not checked."
    )
    expect(describeReconciliation(readout({ resolvedByCheck: 2, unchecked: ['XYZ', 'ABC'] }), 'Binance').line).toMatch(
      /2 orders the exchange no longer rested were resolved by the check\. XYZ, ABC could not be read, so those holdings were not checked\.$/
    )
  })

  it('lists each thing the ledger does not agree with, in the words the notices use', () => {
    const order = { orderId: 777, symbol: 'ETHUSDT', side: 'sell' as const, status: 'NEW', origQty: 0.05, executedQty: 0, price: 4000, placedAt: T }
    const discrepancy = { asset: 'ETH', ledgerQty: 1, exchangeQty: 0.4, shortfall: 0.6, symbols: ['ETHUSDT'] }
    const words = describeReconciliation(readout({ unknownOrders: [order], discrepancies: [discrepancy], resolvedByCheck: 1 }), 'Binance')
    expect(words.tone).toBe('down')
    expect(words.line).toBe('Checked at 12:00 UTC: 2 things the ledger does not agree with. Nothing was changed. 1 order the exchange no longer rested was resolved by the check.')
    expect(words.findings).toHaveLength(2)
    expect(words.findings[0]).toBe(describeUnknownOrder(order, 'Binance'))
    expect(words.findings[0]).toBe('ETHUSDT: a SELL of 0.05 at 4000 is resting on Binance (order 777, placed 12:00 UTC), and this app has no record of it.')
    expect(words.findings[1]).toMatch(/ETH/)
    expect(describeReconciliation(readout({ unknownOrders: [order] }), 'Binance').line).toBe('Checked at 12:00 UTC: 1 thing the ledger does not agree with. Nothing was changed.')
  })
})

describe('describeUserStream', () => {
  it('says why it is closed, that it is opening, what stopped it, and what it has heard', () => {
    const now = T * 1000
    expect(describeUserStream(emptyUserStreamState(), now)).toEqual({
      line: 'Closed: nothing to hear. It opens while a Binance key is stored and the session is armed or an order or position of this app is open.',
      tone: 'muted'
    })
    expect(describeUserStream({ ...emptyUserStreamState(), wanted: true }, now)).toEqual({ line: 'Opening...', tone: 'down' })
    expect(describeUserStream({ ...emptyUserStreamState(), wanted: true, error: 'Binance listen key request failed: 401' }, now)).toEqual({
      line: 'Not open: Binance listen key request failed: 401',
      tone: 'down'
    })
    expect(describeUserStream({ ...emptyUserStreamState(), wanted: true, open: true, connects: 1 }, now)).toEqual({
      line: 'Open: 0 order reports and 0 balance frames since the start, no frame yet.',
      tone: 'up'
    })
    expect(describeUserStream({ ...emptyUserStreamState(), wanted: true, open: true, connects: 2, drops: 1, orders: 2, balances: 1, lastFrameAt: now - 12_000 }, now).line).toBe(
      'Open: 2 order reports and 1 balance frame since the start, the last 12 s ago; 1 drop, reconnected.'
    )
  })
})
