import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DISCOVERY_LINES, type DiscoveryState } from '../shared/traders/discovery'

// FOUND FOR YOU (src/traders/FoundTradersCard.tsx; V9 Stage 3): the traders the app found, each with the ranking's
// figures and its analysis or its status, the rule in words, that their verdicts describe them, that following is the
// person's click, and that Hyperliquid's leaderboard is not in its documented API. And the service can do nothing else.

vi.mock('electron', () => ({}))

async function render(element: ReactElement): Promise<string> {
  const { I18nProvider } = await import('../src/i18n/I18nProvider')
  const { ThemeProvider } = await import('../src/theme/ThemeContext')
  const html = renderToStaticMarkup(createElement(ThemeProvider, null, createElement(I18nProvider, { language: 'en' }, element)))
  return html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

const FOUND_AT = Date.UTC(2026, 10, 6, 6, 2) / 1000

const state: DiscoveryState = {
  enabled: true,
  lastReadAt: FOUND_AT,
  sources: [
    { venue: 'okx', ok: true, rows: 220, passed: 41, error: null },
    { venue: 'hyperliquid', ok: false, rows: 0, passed: 0, error: "Hyperliquid's leaderboard could not be read: it answered 503" }
  ],
  found: [
    {
      key: 'hyperliquid-0x7fdafde5cfb5465924316eced2d3715494c517d1',
      foundAt: FOUND_AT,
      rank: 1,
      board: { venue: 'hyperliquid', id: '0x7fdafde5cfb5465924316eced2d3715494c517d1', name: 'BobbyBigSize', accountUsd: 47_859_298, pnlAllTime: 159_854_473, last30d: 33_262_401, volume30d: 2.46e9, leadDays: null, copiers: null, winRatio: null },
      status: 'analysed',
      why: null,
      latest: { at: FOUND_AT + 600, trips: 412, netUsd: 1_250_000, skill: 'MARKET OR LUCK', clone: null, followerNetPct: -0.04 }
    },
    {
      key: 'okx-F6476365DB0D09A3',
      foundAt: FOUND_AT,
      rank: 2,
      board: { venue: 'okx', id: 'F6476365DB0D09A3', name: 'maomao12345', accountUsd: 15_600, pnlAllTime: 2_755_220, last30d: 0.12, volume30d: null, leadDays: 1132, copiers: 72, winRatio: 0.56 },
      status: 'queued',
      why: null,
      latest: null
    },
    {
      key: 'okx-AAAAAAAAAAAAAAA1',
      foundAt: FOUND_AT,
      rank: 3,
      board: { venue: 'okx', id: 'AAAAAAAAAAAAAAA1', name: 'gone', accountUsd: 60_000, pnlAllTime: 100_000, last30d: 0.05, volume30d: null, leadDays: 200, copiers: 3, winRatio: 0.5 },
      status: 'skipped',
      why: 'OKX has no lead trader with that code: they may have stopped leading.',
      latest: null
    }
  ],
  analysed: 1,
  queued: 1,
  analysing: null,
  nextAnalysisAt: null
}

describe('Found for you', () => {
  it('lists each found trader with the figures it was found by, and its analysis or status', async () => {
    const { FoundTradersView } = await import('../src/traders/FoundTradersCard')
    const html = await render(createElement(FoundTradersView, { state, busy: false, onToggle: () => undefined, onOpen: () => undefined }))
    expect(html).toContain('Found for you')
    expect(html).toContain('Find traders every day')
    expect(html).toContain(`picks up to ${DISCOVERY_LINES.newPerDay} traders by a fixed rule`)
    expect(html).toContain('OKX: 220 read, 41 pass the rule. Hyperliquid: not read.')
    expect(html).toContain('BobbyBigSize')
    expect(html).toContain('+$159.9M')
    expect(html).toContain('412 trips, +$1.3M after fees')
    expect(html).toContain('MARKET OR LUCK')
    expect(html).toContain('A follower a minute late: -0.04% a trip')
    // OKX's thirty days are a return; its account, the assets its copiers put behind it.
    expect(html).toContain('+12.0%')
    expect(html).toContain("copiers' assets")
    expect(html).toContain('waiting to be analysed')
    expect(html).toContain('could not be read: <bdi lang="en">OKX has no lead trader with that code')
    // Open only where there is an analysis to open.
    expect(html.match(/>Open</g)).toHaveLength(1)
    expect(html).toContain('1 found trader analysed. They were picked for their past profit, so their tests describe them and prove nothing')
    expect(html).toContain('press Follow on paper there')
    expect(html).toContain("Hyperliquid's leaderboard is the site's own data, not part of its documented API.")
  })

  it('says when none is found yet, and when finding is off', async () => {
    const { FoundTradersView } = await import('../src/traders/FoundTradersCard')
    expect(await render(createElement(FoundTradersView, { state: { ...state, found: [] }, busy: false, onToggle: () => undefined, onOpen: () => undefined }))).toContain('None found yet')
    expect(await render(createElement(FoundTradersView, { state: { ...state, enabled: false, found: [] }, busy: false, onToggle: () => undefined, onOpen: () => undefined }))).toContain('Finding traders is off.')
  })
})

describe('the finding service', () => {
  const source = readFileSync(join(__dirname, '..', 'electron', 'services', 'discoveryService.ts'), 'utf-8')

  it('reads two public rankings and the traders it found, and does nothing else', () => {
    // Its reads: OKX's ranking through the OKX client and its budget, and one file of Hyperliquid's.
    expect(source).toContain('okxGet(OKX_LEADERS_PATH,')
    expect(source).toContain('fetch(HYPERLIQUID_BOARD_URL,')
    expect([...source.matchAll(/fetch\(/g)]).toHaveLength(1)
    // It follows, clones, places and asks nothing, and writes only its own switch to the settings.
    expect(source).not.toMatch(/setFollow|setClone|traders\.follow|placeOrder|liveTrading|credentials|apiKey|aiService|openrouter/i)
    expect([...source.matchAll(/setSettings\([^\r\n]*/g)].map((match) => match[0])).toEqual(['setSettings({ discovery: { enabled: on } })'])
    // Every read it makes is in the background lane.
    expect(source).toContain('await inBackground(async () => {')
  })
})
