import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EVENT_IMPACT, EVENT_IMPACT_LINES, EVENT_IMPACT_VERSION, IMPACT_WINDOWS } from '../shared/calendar/eventImpact'
import { MACRO_CALENDAR_READ_AT, MACRO_CALENDAR_VERSION, MACRO_EVENTS, MACRO_KINDS, PRE_EVENT_SEC, nextReleases, preEventAt, releaseAhead, releasesBetween, type MacroEvent } from '../shared/calendar/macro'
import { SHOCK_LINES } from '../shared/forecast/shock'
// @ts-expect-error the research script is plain JavaScript; its parsers are tested as they run.
import { easternToUtcSec, parseBlsLines, parseBlsRows, parseFomc } from '../research/fetch-macro-calendar.mjs'

// THE MACRO CALENDAR (shared/calendar/macro.ts, research/fetch-macro-calendar.mjs; V7.1 Stage 12, 16 October
// 2026): the year's U.S. releases as data, each Eastern time turned into UTC by the daylight-saving rule;
// the hour before a release as the market's PRE_EVENT state; and the shipped history of what Bitcoin did
// after the releases inside the bars on file (research/eventImpact.ts).

const utc = (text: string): number => Date.parse(text) / 1000
const at = (kind: string, date: string): MacroEvent => MACRO_EVENTS.find((event) => event.kind === kind && event.date === date)!

describe('the calendar on file', () => {
  it('holds the 45 releases of 2026, oldest first, each of a known kind at the right UTC moment', () => {
    expect(MACRO_CALENDAR_VERSION).toBe('macro-calendar-v1')
    expect(MACRO_CALENDAR_READ_AT).toBe('2026-10-16')
    expect(MACRO_EVENTS).toHaveLength(45)
    expect(MACRO_EVENTS.map((event) => event.kind).filter((kind) => kind === 'CPI')).toHaveLength(12)
    expect(MACRO_EVENTS.filter((event) => event.kind === 'PPI')).toHaveLength(13)
    expect(MACRO_EVENTS.filter((event) => event.kind === 'JOBS')).toHaveLength(12)
    expect(MACRO_EVENTS.filter((event) => event.kind === 'FOMC')).toHaveLength(8)
    expect(MACRO_EVENTS.every((event, index) => index === 0 || event.at >= MACRO_EVENTS[index - 1].at)).toBe(true)
    expect(MACRO_EVENTS.every((event) => (MACRO_KINDS as readonly string[]).includes(event.kind) && event.date.startsWith('2026-'))).toBe(true)
    // 8:30 AM Eastern is 13:30 UTC in winter and 12:30 UTC from the second Sunday of March to the first
    // Sunday of November; the FOMC statement at 2:00 PM Eastern.
    expect(at('CPI', '2026-01-13').at).toBe(utc('2026-01-13T13:30:00Z'))
    expect(at('CPI', '2026-03-11').at).toBe(utc('2026-03-11T12:30:00Z'))
    expect(at('JOBS', '2026-03-06').at).toBe(utc('2026-03-06T13:30:00Z'))
    expect(at('CPI', '2026-10-14').at).toBe(utc('2026-10-14T12:30:00Z'))
    expect(at('CPI', '2026-11-10').at).toBe(utc('2026-11-10T13:30:00Z'))
    expect(at('FOMC', '2026-09-16').at).toBe(utc('2026-09-16T18:00:00Z'))
    expect(at('FOMC', '2026-12-09').at).toBe(utc('2026-12-09T19:00:00Z'))
    expect(at('CPI', '2026-10-14').reference).toBe('September 2026')
    expect(at('CPI', '2026-10-14').timeEt).toBe('08:30')
  })

  it("agrees with the schedule as read by hand, kept for the day the site refuses a script", () => {
    const text = readFileSync(join(__dirname, '..', 'research', 'macro-2026-bls.txt'), 'utf-8')
    const byHand = parseBlsLines(text, 2026) as MacroEvent[]
    expect(byHand).toHaveLength(37)
    const onFile = MACRO_EVENTS.filter((event) => event.kind !== 'FOMC').map((event) => `${event.kind} ${event.date} ${event.at}`)
    expect(byHand.map((event) => `${event.kind} ${event.date} ${event.at}`).sort()).toEqual([...onFile].sort())
  })
})

describe("the script's parsers", () => {
  it('turns Eastern time into UTC seconds across the daylight-saving changes', () => {
    expect(easternToUtcSec(2026, 2, 7, 8, 30)).toBe(utc('2026-03-07T13:30:00Z'))
    expect(easternToUtcSec(2026, 2, 8, 8, 30)).toBe(utc('2026-03-08T12:30:00Z'))
    // The first moment of daylight time: 3:00 AM on the second Sunday of March is 07:00 UTC; a minute before,
    // 1:59 AM standard time, 06:59 UTC.
    expect(easternToUtcSec(2026, 2, 8, 3, 0)).toBe(utc('2026-03-08T07:00:00Z'))
    expect(easternToUtcSec(2026, 2, 8, 1, 59)).toBe(utc('2026-03-08T06:59:00Z'))
    expect(easternToUtcSec(2026, 9, 31, 14, 0)).toBe(utc('2026-10-31T18:00:00Z'))
    expect(easternToUtcSec(2026, 10, 1, 8, 30)).toBe(utc('2026-11-01T13:30:00Z'))
    expect(easternToUtcSec(2027, 2, 14, 8, 30)).toBe(utc('2027-03-14T12:30:00Z'))
  })

  it("reads the BLS year page's rows and the Fed's meeting list", () => {
    const html = `<table><tr class="release-list-even-row"> <td class="date-cell"><p>Friday, January 9, 2026</p></td> <td class="time-cell"><p>08:30 AM</p></td> <td class="desc-cell"><p><strong>Employment Situation</strong> for December 2025</p></td></tr>
      <tr><td class="date-cell"><p>Wednesday, October 14, 2026</p></td><td class="time-cell"><p>08:30 AM</p></td><td class="desc-cell"><p><strong>Consumer Price Index</strong> for September 2026</p></td></tr>
      <tr><td class="date-cell"><p>Tuesday, October 20, 2026</p></td><td class="time-cell"><p>10:00 AM</p></td><td class="desc-cell"><p><strong>Real Earnings</strong> for September 2026</p></td></tr>
      <tr><td class="date-cell"><p>Friday, January 8, 2027</p></td><td class="time-cell"><p>08:30 AM</p></td><td class="desc-cell"><p><strong>Employment Situation</strong> for December 2026</p></td></tr>
      <tr><td class="date-cell"><p>Thursday, June 11, 2026</p></td><td class="time-cell"><p>02:15 PM</p></td><td class="desc-cell"><p><strong>Producer Price Index</strong> for May 2026</p></td></tr>
      <tr><td class="date-cell"><p>Friday, June 12, 2026</p></td><td class="time-cell"><p>12:30 PM</p></td><td class="desc-cell"><p><strong>Consumer Price Index</strong> for May 2026</p></td></tr>
      <tr><td class="date-cell"><p>Monday, June 15, 2026</p></td><td class="time-cell"><p>12:05 AM</p></td><td class="desc-cell"><p><strong>Employment Situation</strong> for May 2026</p></td></tr></table>`
    const rows = parseBlsRows(html, 2026) as (MacroEvent & { reference: string })[]
    expect(rows.map((row) => [row.kind, row.date, row.timeEt, row.reference])).toEqual([
      ['JOBS', '2026-01-09', '08:30', 'December 2025'],
      ['CPI', '2026-10-14', '08:30', 'September 2026'],
      ['PPI', '2026-06-11', '14:15', 'May 2026'],
      ['CPI', '2026-06-12', '12:30', 'May 2026'],
      ['JOBS', '2026-06-15', '00:05', 'May 2026']
    ])
    expect(rows[1].at).toBe(utc('2026-10-14T12:30:00Z'))
    expect(rows[2].at).toBe(utc('2026-06-11T18:15:00Z'))
    // Twelve o'clock is noon or midnight, not twenty-four.
    expect(rows[3].at).toBe(utc('2026-06-12T16:30:00Z'))
    expect(rows[4].at).toBe(utc('2026-06-15T04:05:00Z'))
    const fed = '<h4>2026 FOMC Meetings</h4><div>January 27-28 <a>Statement</a> March 17-18* <a>x</a> April 28-29 ... December 8-9* * Meeting associated</div><h4>2025 FOMC Meetings</h4><div>December 9-10</div>'
    expect((parseFomc(fed, 2026) as MacroEvent[]).map((event) => [event.kind, event.date, event.timeEt])).toEqual([
      ['FOMC', '2026-01-28', '14:00'],
      ['FOMC', '2026-03-18', '14:00'],
      ['FOMC', '2026-04-29', '14:00'],
      ['FOMC', '2026-12-09', '14:00']
    ])
    // A meeting across two months ends in the second.
    expect((parseFomc('<p>2026 FOMC Meetings April 30-May 1 x</p>', 2026) as MacroEvent[])[0].date).toBe('2026-05-01')
    expect(() => parseFomc('<p>nothing</p>', 2026)).toThrow()
  })
})

describe('the hour before a release', () => {
  const cpi = at('CPI', '2026-10-14')

  it('is PRE_EVENT from an hour before the release up to it, not at it or after', () => {
    expect(PRE_EVENT_SEC).toBe(3600)
    expect(preEventAt(cpi.at - 3600)).toBe(true)
    expect(preEventAt(cpi.at - 1)).toBe(true)
    expect(preEventAt(cpi.at - 3601)).toBe(false)
    expect(preEventAt(cpi.at)).toBe(false)
    expect(preEventAt(cpi.at + 1)).toBe(false)
    expect(releaseAhead(cpi.at - 900)).toEqual(cpi)
    expect(releaseAhead(cpi.at - 900, [])).toBeNull()
    // Two releases within the hour: the nearer.
    const two: MacroEvent[] = [{ ...cpi, at: cpi.at + 1200 }, cpi]
    expect(releaseAhead(cpi.at - 600, two)).toEqual(cpi)
    expect(preEventAt(cpi.at - 600, two)).toBe(true)
  })

  it('lists the releases of a span and the next from a moment', () => {
    expect(releasesBetween(utc('2026-10-01T00:00:00Z'), utc('2026-10-31T23:59:59Z')).map((event) => event.date)).toEqual(['2026-10-02', '2026-10-14', '2026-10-15', '2026-10-28'])
    expect(releasesBetween(cpi.at, cpi.at)).toEqual([cpi])
    expect(releasesBetween(cpi.at + 1, cpi.at + 86_400)).toEqual([at('PPI', '2026-10-15')])
    expect(nextReleases(cpi.at + 1, 2).map((event) => event.date)).toEqual(['2026-10-15', '2026-10-28'])
    // A release at the moment itself is the next.
    expect(nextReleases(cpi.at, 1)).toEqual([cpi])
    expect(nextReleases(utc('2027-01-01T00:00:00Z'), 3)).toEqual([])
  })

  it('reads nothing from a file of another version', async () => {
    vi.resetModules()
    vi.doMock('../shared/calendar/macro-2026.json', () => ({ default: { version: 'macro-calendar-v0', year: 2026, readAt: '2026-10-16', events: [{ kind: 'CPI', name: 'x', date: '2026-10-14', timeEt: '08:30', at: 1 }] } }))
    const other = await import('../shared/calendar/macro')
    expect(other.MACRO_EVENTS).toEqual([])
    expect(other.preEventAt(0)).toBe(false)
    vi.doUnmock('../shared/calendar/macro-2026.json')
    vi.resetModules()
  })
})

describe('the event impact history on file', () => {
  it('holds every release inside the bars it was made from, by kind, each kind said too few under thirty', () => {
    expect(EVENT_IMPACT).not.toBeNull()
    const file = EVENT_IMPACT!
    expect(file.version).toBe(EVENT_IMPACT_VERSION)
    expect(file.minSamples).toBe(EVENT_IMPACT_LINES.minSamples)
    expect(EVENT_IMPACT_LINES.minSamples).toBe(30)
    expect(file.source.pair).toBe('BTCUSDT')
    expect(file.events.length).toBeGreaterThanOrEqual(11)
    const moments = new Set(MACRO_EVENTS.map((event) => event.at))
    for (const row of file.events) {
      expect(moments.has(row.at), row.date).toBe(true)
      expect(row.at >= file.source.fromSec && row.at <= file.source.toSec).toBe(true)
      for (const window of IMPACT_WINDOWS) expect(Number.isFinite(row.movePct[window]) && Number.isFinite(row.z[window]), `${row.date} ${window}`).toBe(true)
      expect(row.maxUpPct).toBeGreaterThanOrEqual(0)
      expect(row.maxDownPct).toBeLessThanOrEqual(0)
      expect(row.shockAfter).toBe(Math.abs(row.z.m15) >= SHOCK_LINES.line)
    }
    for (const kind of MACRO_KINDS) {
      const entry = file.kinds[kind]
      expect(entry.n).toBe(file.events.filter((row) => row.kind === kind).length)
      expect(entry.enough).toBe(entry.n >= file.minSamples)
      expect(entry.enough).toBe(false)
    }
    // The 14 October 2026 CPI, the release this was built for: a shock after, the fall first.
    const cpi = file.events.find((row) => row.date === '2026-10-14')!
    expect(cpi.kind).toBe('CPI')
    expect(cpi.shockAfter).toBe(true)
    expect(cpi.z.m15).toBeLessThan(-SHOCK_LINES.line)
    expect(cpi.touchDownMin).toBe(5)
    expect(cpi.touchUpMin).toBeNull()
  })
})
