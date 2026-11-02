import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NEWS_CONFIG, applyNewsConfigPatch, copyNewsConfig, type NewsConfig } from '../shared/news'
import type { BookStanding } from '../shared/paperBooks'
import { PAPER_TESTING_VERSION, readStartedRecord, restorePatchOf, startPatchOf, switchStateOf, switchesToTurnOn, type PaperTestingState } from '../shared/paperTesting'
import { ENGLISH } from '../shared/i18n/translate'
import { PaperTestingView, readerLine, startItems, stopItems } from '../src/trading/PaperTestingCard'

// START AND STOP PAPER TESTING, THE ARITHMETIC AND THE CARD (shared/paperTesting.ts, src/trading/PaperTestingCard.tsx;
// V8 Stage 9): Start turns on only the switches that are off -- the reader, the delisting's short, delistings put to the
// watch's models -- and records each one's earlier value; Stop's patch puts exactly those back; the Monitoring Tag's
// short is never touched. The card names all of it before either is done.

const patched = (config: NewsConfig, patch: Parameters<typeof applyNewsConfigPatch>[1]): NewsConfig => {
  const next = applyNewsConfigPatch(config, patch)
  if (typeof next === 'string') throw new Error(next)
  return next
}

describe('the switches Start turns on', () => {
  it('are those off now, each with its earlier value; the tag short is left as it is', () => {
    expect(switchesToTurnOn(DEFAULT_NEWS_CONFIG)).toEqual([
      { switch: 'news.enabled', was: false },
      { switch: 'news.delisting.paperShort', was: false }
    ])
    const allOff = patched(DEFAULT_NEWS_CONFIG, { delisting: { askModels: false } })
    const switched = switchesToTurnOn(allOff)
    expect(switched.map((entry) => entry.switch)).toEqual(['news.enabled', 'news.delisting.paperShort', 'news.delisting.askModels'])
    const on = patched(allOff, startPatchOf(switched))
    expect(switchStateOf(on)).toEqual({ 'news.enabled': true, 'news.delisting.paperShort': true, 'news.delisting.askModels': true })
    expect(on.monitoringTag).toEqual(allOff.monitoringTag)
    expect(on.delisting.paperShort.stakeQuote).toBe(allOff.delisting.paperShort.stakeQuote)
    expect(switchesToTurnOn(on)).toEqual([])
    expect(startPatchOf([])).toEqual({})
  })

  it("are put back exactly by Stop's patch, whatever they were changed to since, and nothing else is", () => {
    const before = patched(DEFAULT_NEWS_CONFIG, { monitoringTag: { paperShort: { enabled: true } } })
    const switched = switchesToTurnOn(before)
    // Changed during the run: the reader stopped itself, and the delisting's models were switched off by hand.
    const during = patched(patched(before, startPatchOf(switched)), { enabled: false, delisting: { askModels: false } })
    const after = patched(during, restorePatchOf(switched))
    expect(switchStateOf(after)).toEqual({ 'news.enabled': false, 'news.delisting.paperShort': false, 'news.delisting.askModels': false })
    expect(after.monitoringTag.paperShort.enabled).toBe(true)
    expect(restorePatchOf([{ switch: 'news.delisting.askModels', was: true }])).toEqual({ delisting: { askModels: true } })
    expect(copyNewsConfig(after)).toEqual(after)
  })
})

describe('started.json as read', () => {
  it('is whole or nothing: a switch it does not know, twice, or with no earlier value is not one to put back', () => {
    const record = { v: PAPER_TESTING_VERSION, startedAt: 1_793_000_000, switched: [{ switch: 'news.enabled', was: false }] }
    expect(readStartedRecord(record)).toEqual(record)
    expect(readStartedRecord({ ...record, switched: [] })).toEqual({ ...record, switched: [] })
    for (const bad of [
      null,
      { ...record, v: 'paper-testing-v0' },
      { ...record, startedAt: 0 },
      { ...record, switched: 'news.enabled' },
      { ...record, switched: [{ switch: 'scanner.enabled', was: false }] },
      { ...record, switched: [{ switch: 'news.enabled' }] },
      { ...record, switched: [record.switched[0], record.switched[0]] }
    ]) {
      expect(readStartedRecord(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

const NOW = 1_793_010_000
const standing = (id: BookStanding['id'], over: Partial<BookStanding> = {}): BookStanding => ({ id, startQuote: 10_000, realizedQuote: 0, unrealizedQuote: 0, settledEquity: 10_000, equity: 10_000, open: 0, openStakeQuote: 0, closed: 0, dayStartEquity: 10_000, ...over })
const state = (over: Partial<PaperTestingState> = {}): PaperTestingState => ({
  running: false,
  startedAt: null,
  started: null,
  standings: [standing('news'), standing('copy'), standing('baseline')],
  switches: { 'news.enabled': false, 'news.delisting.paperShort': false, 'news.delisting.askModels': true },
  tagShort: false,
  reader: { lastReadAt: null, error: null, health: { failuresInRow: 0, stoppedAt: null, stoppedReason: null } },
  follows: 2,
  clones: 1,
  ...over
})
const draw = (props: Partial<Parameters<typeof PaperTestingView>[0]> & { state: PaperTestingState }): string =>
  renderToStaticMarkup(createElement(PaperTestingView, { nowSec: NOW, confirming: null, busy: false, problem: null, note: null, onAsk: () => undefined, onCancel: () => undefined, onStart: () => undefined, onStop: () => undefined, ...props }))

describe('the Paper testing card', () => {
  it("names, before Start, every switch it turns on or finds on, and what it uses as it is", () => {
    expect(startItems(state(), ENGLISH)).toEqual([
      "Binance's announcements, read every minute: switched on.",
      "The delisting rule's short, in the news book: switched on.",
      "Delistings put to the watch's models, while the watch is on, within its $5 a day: already on.",
      "The Monitoring Tag's bracket short: off, and left off (Settings › Market switches it).",
      'Follows of the traders you follow on Copy Traders: 2; clones run: 1. They enter only positions opened from now.',
      "The baseline: Trend Regime Ensemble on BTC, ETH, SOL, ADA, BNB, LINK, LTC, and XRP, long on Binance's spot, at its 4-hour closes from the next one, on signals of its own after Start."
    ])
    const html = draw({ state: state(), confirming: 'start' })
    expect(html).toContain('Start paper testing?')
    expect(html).toContain('Stop puts back each switch Start turned on')
    expect(draw({ state: state() })).toContain('Not yet running.')
    expect(draw({ state: state() })).not.toContain('Stop paper testing')
  })

  it('shows, while running, each book, the reader, what Start turned on; and names before Stop what it closes and puts back', () => {
    const running = state({
      running: true,
      startedAt: NOW - 7200,
      started: { v: PAPER_TESTING_VERSION, startedAt: NOW - 7200, switched: [{ switch: 'news.enabled', was: false }] },
      standings: [standing('news', { open: 1, equity: 10_012.5 }), standing('copy', { equity: null }), standing('baseline', { open: 2 })],
      switches: { 'news.enabled': true, 'news.delisting.paperShort': true, 'news.delisting.askModels': true },
      reader: { lastReadAt: NOW - 20, error: null, health: { failuresInRow: 0, stoppedAt: null, stoppedReason: null } }
    })
    const html = draw({ state: running })
    expect(html).toContain('Running since 26 Oct 08:20 UTC (2.0 h).')
    expect(html).toContain('$10,012.50')
    expect(html).toContain('not priced')
    expect(html).toContain("Binance&#x27;s announcements: last read 20 s ago.")
    expect(html).toContain('Start turned on: Binance&#x27;s announcements, read every minute.')
    expect(stopItems(running, ENGLISH)).toEqual(["Binance's announcements, read every minute: back off."])
    expect(stopItems({ started: { v: PAPER_TESTING_VERSION, startedAt: 1, switched: [{ switch: 'news.delisting.askModels', was: true }] } }, ENGLISH)).toEqual([
      "Delistings put to the watch's models, while the watch is on, within its $5 a day: back on."
    ])
    const stop = draw({ state: running, confirming: 'stop' })
    expect(stop).toContain('The books&#x27; 3 open trades close at the price then.')
    expect(stopItems(state({ started: { v: PAPER_TESTING_VERSION, startedAt: 1, switched: [] } }), ENGLISH)).toEqual(['No switch to put back: everything paper testing reads was already on at Start, and stays on.'])
    // A Stop that could not put a switch back: Stop again.
    const pending = draw({ state: state({ startedAt: NOW - 60, started: running.started }) })
    expect(pending).toContain('Stop paper testing again')
    expect(pending).not.toContain('>Start paper testing<')
  })

  it("says the reader's health: reading, reading nothing so many times in a row, or stopped by itself", () => {
    const on = { 'news.enabled': true, 'news.delisting.paperShort': true, 'news.delisting.askModels': true }
    expect(readerLine(state({ switches: on, reader: { lastReadAt: NOW - 125, error: 'busy', health: { failuresInRow: 2, stoppedAt: null, stoppedReason: null } } }), NOW, ENGLISH)).toBe(
      "Binance's announcements: last read 2 min ago, reading nothing 2 times in a row (busy); at 3 it stops itself."
    )
    expect(readerLine(state({ switches: on, reader: { lastReadAt: NOW - 65, error: 'busy', health: { failuresInRow: 1, stoppedAt: null, stoppedReason: null } } }), NOW, ENGLISH)).toBe(
      "Binance's announcements: last read 1 min ago, reading nothing 1 time in a row (busy); at 3 it stops itself."
    )
    expect(readerLine(state({ switches: on, reader: { lastReadAt: NOW - 5, error: '1 of 3 lists', health: { failuresInRow: 0, stoppedAt: null, stoppedReason: null } } }), NOW, ENGLISH)).toBe("Binance's announcements: last read 5 s ago, in part (1 of 3 lists).")
    expect(readerLine(state({ reader: { lastReadAt: NOW - 5, error: 'x', health: { failuresInRow: 3, stoppedAt: NOW - 60, stoppedReason: 'answered 451' } } }), NOW, ENGLISH)).toMatch(/stopped itself at .* after 3 reads in a row read nothing \(answered 451\)/)
    expect(readerLine(state(), NOW, ENGLISH)).toBe("Binance's announcements: not being read.")
    expect(readerLine(state({ switches: on }), NOW, ENGLISH)).toBe("Binance's announcements: not read yet.")
  })
})
