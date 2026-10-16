import { describe, expect, it } from 'vitest'
import type { MacroEvent } from '../shared/calendar/macro'
import { DIRECTION_LINES } from '../shared/forecast/direction'
import { EVENT_REPLAY_VERSION, eventReplayOf, releaseHours, type EventReplayInput } from '../shared/forecast/eventReplay'
import { scoreShock } from '../shared/forecast/shock'
import { gaussOf, rng } from './forecastRecords'

// A SCHEDULED RELEASE REPLAYED ON THE WALK FORWARD (shared/forecast/eventReplay.ts; V7.1 Stage 12): the
// record's hour before a release and the first hour at or after it, every pair together, as forecast and
// widened by the rules fitted on the other weeks, with the state, Bitcoin's fifteen minutes and the calls.

const levels = [-1.2816, -0.6745, 0, 0.6745, 1.2816]
const WEEK = 604_800
const cpi = (at: number): MacroEvent => ({ kind: 'CPI', name: 'Consumer Price Index', date: '2026-10-14', timeEt: '08:30', at })

/** Three weeks of hourly rows of twenty pairs: at 13:00 each day Bitcoin fell past the line and the moves ran
 * two and a half times as wide as the levels (a POST_EVENT_SHOCK hour); at 15:00, with the states, a
 * RECOVERY hour whose moves are refused a rule (week 1's all out, the other weeks' all in: cross-fitted,
 * widening brings nothing nearer); every other hour calm. With `lineRefused`, the shock hours are made the
 * same way, so the line's rule is refused with factors above 1 all the same. */
function world(options: { states?: boolean; pUp?: boolean; lineRefused?: boolean } = {}): EventReplayInput[] {
  const gauss = gaussOf(rng(5))
  const rows: EventReplayInput[] = []
  const refused = (week: number): number => (week === 1 ? 1.5 * 1.2816 : 0.5 * 1.2816 * gauss())
  for (let week = 1; week <= 3; week++) {
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const t = week * WEEK + day * 86_400 + hour * 3600
        const shock = hour === 13
        const recovery = options.states === true && hour === 15
        for (let pair = 0; pair < 20; pair++) {
          const z = shock ? (options.lineRefused === true ? refused(week) : 2.5 * gauss()) : recovery ? refused(week) : gauss()
          rows.push({
            t,
            pair: `P${pair}USDT`,
            z,
            q: levels,
            week,
            btc15: shock ? -7 : 0.3,
            ...(options.states === true ? { state: shock ? 'POST_EVENT_SHOCK' : recovery ? 'RECOVERY' : 'NORMAL' } : {}),
            // With calls: half the pairs call up at 0.6, the rest call nothing.
            pUp: options.pUp === true ? (pair % 2 === 0 ? 0.6 : 0.5) : null
          })
        }
      }
    }
  }
  return rows
}

describe('the hours a release is read at', () => {
  it('are the last strictly before it and the first at or after it', () => {
    const noon = Date.parse('2026-10-14T12:00:00Z') / 1000
    expect(releaseHours(noon + 1800)).toEqual({ before: noon, after: noon + 3600 })
    expect(releaseHours(noon)).toEqual({ before: noon - 3600, after: noon })
    expect(releaseHours(noon + 3599)).toEqual({ before: noon, after: noon + 3600 })
    expect(EVENT_REPLAY_VERSION).toBe('event-replay-v1')
  })
})

describe('a release replayed', () => {
  // The CPI at 12:30 of the third day of week 2: its hour before is 12:00, calm; its first hour after 13:00, a shock.
  const at = 2 * WEEK + 2 * 86_400 + 12 * 3600 + 1800

  it('reads the hour before and the first hour after, every pair together, as forecast and widened by the rules', () => {
    const rows = world()
    const made = eventReplayOf(rows, [cpi(at)])
    expect(made.map((row) => [row.kind, row.hour, row.t - at, row.n])).toEqual([
      ['CPI', 'before', -1800, 20],
      ['CPI', 'after', 1800, 20]
    ])
    const [before, after] = made
    expect(before.btc15).toBe(0.3)
    expect(after.btc15).toBe(-7)
    expect(before.state).toBeNull()
    expect(after.state).toBeNull()
    expect(before.asForecast).toEqual(scoreShock(rows.filter((row) => row.t === at - 1800)))
    // The line's rule, adopted on the 21 shock moments, widens the hour after and leaves the calm hour alone.
    expect(after.byLine).not.toBeNull()
    expect(after.byLine!.in80).toBeGreaterThan(after.asForecast.in80)
    expect(after.byLine!.pinball).toBeLessThan(after.asForecast.pinball)
    expect(before.byLine).toEqual(before.asForecast)
    // Without the states on record, no widening by them.
    expect(after.byStates).toBeNull()
    expect(before.calls).toBe(0)
    expect(after.calls).toBe(0)
  })

  it("widens by the states' rules where the record keeps the states, and counts the calls", () => {
    const rows = world({ states: true, pUp: true })
    const [before, after] = eventReplayOf(rows, [cpi(at)])
    expect(after.state).toBe('POST_EVENT_SHOCK')
    expect(before.state).toBe('NORMAL')
    // Every row past the line is a POST_EVENT_SHOCK row: the state's factors are the line's, to the digit.
    expect(after.byStates).toEqual(after.byLine)
    expect(before.byStates).toEqual(before.asForecast)
    // Ten pairs call up at 0.6: right where the move went up.
    expect(before.calls).toBe(10)
    expect(DIRECTION_LINES.bullish).toBe(0.58)
    const up = rows.filter((row) => row.t === at - 1800 && row.pUp === 0.6 && row.z > 0).length
    expect(before.callsRight).toBe(up)
    // A bearish call is right where the move went down; a row at the line calls; one short of it does not;
    // a move of nought is called by neither way.
    const bearish = eventReplayOf(rows.map((row) => (row.t === at - 1800 ? { ...row, pUp: row.pair === 'P0USDT' ? 0.42 : row.pair === 'P1USDT' ? 0.421 : row.pair === 'P2USDT' ? 0.58 : row.pair === 'P3USDT' ? 0.7 : 0.5, z: row.pair === 'P3USDT' ? 0 : row.z } : row)), [cpi(at)])[0]
    expect(bearish.calls).toBe(3)
    const p0 = rows.find((row) => row.t === at - 1800 && row.pair === 'P0USDT')!
    const p2 = rows.find((row) => row.t === at - 1800 && row.pair === 'P2USDT')!
    expect(bearish.callsRight).toBe((p0.z < 0 ? 1 : 0) + (p2.z > 0 ? 1 : 0))
    // The recovery hour at 15:00: its state's rule refused (week 1's moves all out, the others' all in), the
    // states widen nothing there, though the line's rule stands at 13:00.
    const recovery = eventReplayOf(rows, [cpi(at + 2 * 3600)])
    expect(recovery.map((row) => [row.hour, row.state])).toEqual([
      ['before', 'NORMAL'],
      ['after', 'RECOVERY']
    ])
    expect(recovery[1].byStates).toEqual(recovery[1].asForecast)
    expect(recovery[1].byLine).toEqual(recovery[1].asForecast)
  })

  it("widens by nothing where the line's rule was refused, whatever factors its rows would give", () => {
    const rows = world({ lineRefused: true })
    const [before, after] = eventReplayOf(rows, [cpi(at)])
    expect(after.n).toBe(20)
    expect(after.byLine).toBeNull()
    expect(before.byLine).toBeNull()
    // Week 2's shock rows sit inside their ranges: nothing to widen, and nothing widened.
    expect(after.asForecast.in80).toBeGreaterThan(0.8)
  })

  it('leaves out a release outside the tested weeks, or whose hours hold no row', () => {
    const rows = world()
    expect(eventReplayOf(rows, [cpi(WEEK - 86_400)])).toEqual([])
    expect(eventReplayOf(rows, [cpi(4 * WEEK + 86_400)])).toEqual([])
    // A release just before the first tested hour: its hour after is the first hour, its hour before not there.
    expect(eventReplayOf(rows, [cpi(WEEK - 1800)]).map((row) => row.hour)).toEqual(['after'])
    // A release in the last tested hour: its hour before is read, its hour after is not there.
    const last = rows[rows.length - 1].t
    expect(eventReplayOf(rows, [cpi(last + 1800)]).map((row) => row.hour)).toEqual(['before'])
    expect(eventReplayOf([], [cpi(at)])).toEqual([])
    // Two releases in order, each its own rows.
    expect(eventReplayOf(rows, [cpi(at), { ...cpi(at + 86_400), kind: 'PPI' }]).map((row) => `${row.kind} ${row.hour}`)).toEqual(['CPI before', 'CPI after', 'PPI before', 'PPI after'])
  })
})
