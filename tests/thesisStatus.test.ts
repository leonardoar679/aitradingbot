import { describe, expect, it } from 'vitest'
import { THESIS_LINES, describeThesisReason, describeThesisStatus, describeThesisVerdict, regimeAgainst, thesisStatus, type ThesisInput } from '../shared/thesisStatus'

// shared/thesisStatus.ts: an open position's THESIS STATUS, by fixed lines, shown only. Each line is
// tried at it and just short of it, on a long and on a short.

const VALID: ThesisInput = { side: 'buy', entryPrice: 100, stopPct: 2, price: 100, move15mPct: 0, regimeAtEntry: 'sideways', regimeNow: 'sideways', storyAgainst: null }
const at = (over: Partial<ThesisInput>): ThesisInput => ({ ...VALID, ...over })

describe('the lines', () => {
  it('are the ones in force elsewhere, said once', () => {
    expect(THESIS_LINES).toEqual({ nearStopShare: 0.75, newsImpact: 70, oppositeMovePct: 2, brokenReasons: 2 })
  })
})

describe('VALID', () => {
  it('is nothing against it, with where the price stands to the stop', () => {
    expect(thesisStatus(VALID)).toEqual({ status: 'VALID', reasons: [], stopProgress: 0 })
    expect(thesisStatus(at({ price: 101 }))).toMatchObject({ status: 'VALID', stopProgress: -0.5 })
  })
})

describe('near its stop', () => {
  it('is three quarters of the way from the entry to the stop, either side', () => {
    expect(thesisStatus(at({ price: 98.5 }))).toEqual({ status: 'WEAKENING', reasons: ['near_stop'], stopProgress: expect.closeTo(0.75, 10) })
    expect(thesisStatus(at({ price: 98.52 })).status).toBe('VALID')
    expect(thesisStatus(at({ side: 'sell', price: 101.5 }))).toMatchObject({ status: 'WEAKENING', reasons: ['near_stop'] })
    expect(thesisStatus(at({ side: 'sell', price: 98.5 })).status).toBe('VALID')
  })

  it('is nothing without a stop, however far the price has fallen', () => {
    expect(thesisStatus(at({ stopPct: null, price: 90 }))).toEqual({ status: 'VALID', reasons: [], stopProgress: null })
  })
})

describe('its stop hit', () => {
  it('is BROKEN on its own, at the stop and beyond it', () => {
    expect(thesisStatus(at({ price: 98 }))).toEqual({ status: 'BROKEN', reasons: ['stop_hit'], stopProgress: expect.closeTo(1, 10) })
    expect(thesisStatus(at({ price: 95 })).status).toBe('BROKEN')
    expect(thesisStatus(at({ side: 'sell', price: 102 })).reasons).toEqual(['stop_hit'])
  })

  it('is said once, not also as near', () => {
    expect(thesisStatus(at({ price: 97, storyAgainst: { impact: 80 } })).reasons).toEqual(['stop_hit', 'news_against'])
  })
})

describe('news against it', () => {
  it('is a story of impact 70 or more against the side; a weaker one is not news', () => {
    expect(thesisStatus(at({ storyAgainst: { impact: 70 } }))).toMatchObject({ status: 'WEAKENING', reasons: ['news_against'] })
    expect(thesisStatus(at({ storyAgainst: { impact: 69.9 } })).status).toBe('VALID')
  })
})

describe("Bitcoin's regime", () => {
  it('is against a long when falling or panicking, against a short when rising or recovering', () => {
    expect(['panic', 'bear'].map((regime) => regimeAgainst('buy', regime as never))).toEqual([true, true])
    expect(['bull', 'recovery', 'sideways', 'high-vol'].map((regime) => regimeAgainst('buy', regime as never))).toEqual([false, false, false, false])
    expect(['bull', 'recovery'].map((regime) => regimeAgainst('sell', regime as never))).toEqual([true, true])
    expect(['panic', 'bear', 'sideways', 'high-vol'].map((regime) => regimeAgainst('sell', regime as never))).toEqual([false, false, false, false])
    expect(regimeAgainst('buy', null)).toBe(false)
  })

  it('weakens a thesis when it turned against the side since the entry, not when it was against it already', () => {
    expect(thesisStatus(at({ regimeNow: 'bear' }))).toMatchObject({ status: 'WEAKENING', reasons: ['regime_against'] })
    expect(thesisStatus(at({ regimeNow: 'panic' })).reasons).toEqual(['regime_against'])
    expect(thesisStatus(at({ regimeNow: 'bull' })).status).toBe('VALID')
    expect(thesisStatus(at({ regimeAtEntry: 'bear', regimeNow: 'bear' })).status).toBe('VALID')
    expect(thesisStatus(at({ regimeAtEntry: 'panic', regimeNow: 'bear' })).status).toBe('VALID')
    // Unknown at the entry: against now is a turn.
    expect(thesisStatus(at({ regimeAtEntry: null, regimeNow: 'bear' })).reasons).toEqual(['regime_against'])
    expect(thesisStatus(at({ regimeAtEntry: null, regimeNow: null })).status).toBe('VALID')
    expect(thesisStatus(at({ side: 'sell', regimeNow: 'bull' })).reasons).toEqual(['regime_against'])
    expect(thesisStatus(at({ side: 'sell', regimeNow: 'recovery' })).reasons).toEqual(['regime_against'])
    expect(thesisStatus(at({ side: 'sell', regimeNow: 'bear' })).status).toBe('VALID')
  })
})

describe('a sharp move against it', () => {
  it('is 2% against the side over fifteen minutes; a move its way, or a smaller one, is nothing', () => {
    expect(thesisStatus(at({ move15mPct: -2 }))).toMatchObject({ status: 'WEAKENING', reasons: ['opposite_move'] })
    expect(thesisStatus(at({ move15mPct: -1.99 })).status).toBe('VALID')
    expect(thesisStatus(at({ move15mPct: 2 })).status).toBe('VALID')
    expect(thesisStatus(at({ side: 'sell', move15mPct: 2 })).reasons).toEqual(['opposite_move'])
    expect(thesisStatus(at({ side: 'sell', move15mPct: -2 })).status).toBe('VALID')
    expect(thesisStatus(at({ move15mPct: null })).status).toBe('VALID')
  })
})

describe('BROKEN', () => {
  it('is two reasons at once, in the order the rules are read', () => {
    expect(thesisStatus(at({ price: 98.5, move15mPct: -2 }))).toMatchObject({ status: 'BROKEN', reasons: ['near_stop', 'opposite_move'] })
    expect(thesisStatus(at({ storyAgainst: { impact: 75 }, regimeNow: 'bear' })).status).toBe('BROKEN')
    expect(thesisStatus(at({ price: 98.5, storyAgainst: { impact: 75 }, regimeNow: 'bear', move15mPct: -3 })).reasons).toEqual(['near_stop', 'news_against', 'regime_against', 'opposite_move'])
  })
})

describe('in words', () => {
  it('names each reason, each status with its tone, and the verdict in one sentence', () => {
    expect(describeThesisReason('stop_hit')).toBe('its stop is hit')
    expect(describeThesisReason('near_stop')).toBe('it is near its stop')
    expect(describeThesisReason('news_against')).toBe('news against it')
    expect(describeThesisReason('regime_against')).toBe("Bitcoin's regime turned against it")
    expect(describeThesisReason('opposite_move')).toBe('a sharp move against it')
    expect(describeThesisStatus('VALID')).toMatchObject({ word: 'VALID', tone: 'up' })
    expect(describeThesisStatus('WEAKENING')).toMatchObject({ word: 'WEAKENING', tone: 'gold' })
    expect(describeThesisStatus('BROKEN')).toMatchObject({ word: 'BROKEN', tone: 'down' })
    for (const status of ['VALID', 'WEAKENING', 'BROKEN'] as const) expect(describeThesisStatus(status).detail).toContain('A reading, not a decision')
    expect(describeThesisVerdict({ status: 'VALID', reasons: [] })).toBe('VALID: nothing measured is against it.')
    expect(describeThesisVerdict({ status: 'BROKEN', reasons: ['near_stop', 'opposite_move'] })).toBe('BROKEN: it is near its stop; a sharp move against it.')
  })
})
