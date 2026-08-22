import { describe, it, expect } from 'vitest'
import { describeUnavailable } from '../src/portfolio/unavailableNote'

const none = { unpricedPositions: 0, failedExecutors: 0, failedBots: 0 }

describe('describeUnavailable', () => {
  it('says nothing when the whole snapshot came through', () => {
    expect(describeUnavailable(none)).toBeNull()
  })

  // The headline number on the landing page shrinking with no explanation is the failure this
  // exists to prevent.
  it('names an unpriced position as missing from Total Value', () => {
    const msg = describeUnavailable({ ...none, unpricedPositions: 1 })
    expect(msg).toContain('1 position could not be priced')
    expect(msg).toContain('missing from Total Value')
    expect(msg).toContain('it is')
  })

  it('pluralises unpriced positions', () => {
    const msg = describeUnavailable({ ...none, unpricedPositions: 3 })
    expect(msg).toContain('3 positions could not be priced')
    expect(msg).toContain('they are')
  })

  it('reports unreadable paper executors', () => {
    expect(describeUnavailable({ ...none, failedExecutors: 2 })).toContain('2 paper executors could not be read')
  })

  it('reports bots missing from the P&L average', () => {
    expect(describeUnavailable({ ...none, failedBots: 1 })).toContain('1 bot could not be included in Bot P&L')
  })

  it('reports every kind of failure at once', () => {
    const msg = describeUnavailable({ unpricedPositions: 2, failedExecutors: 1, failedBots: 4 })
    expect(msg).toContain('2 positions')
    expect(msg).toContain('1 paper executor')
    expect(msg).toContain('4 bots')
    expect(msg).toContain(';')
  })

  // A shrinking total reads as "I lost money". Saying which it is matters more than saying that
  // something failed.
  it('says the holdings did not change, only the fetch failed', () => {
    const msg = describeUnavailable({ ...none, unpricedPositions: 1 })
    expect(msg).toContain('not a change in what you hold')
    expect(msg).toContain('retrying automatically')
  })

  it('ignores negative counts rather than emitting nonsense', () => {
    expect(describeUnavailable({ unpricedPositions: -1, failedExecutors: -2, failedBots: -3 })).toBeNull()
  })
})
