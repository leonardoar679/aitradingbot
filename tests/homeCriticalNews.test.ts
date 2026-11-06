import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { loudFirstReports } from '../shared/incidents'
import type { ReadStory, StoryIncident } from '../shared/newsFeed'

// HOME'S CRITICAL NEWS (V9 Stage 2, 6 November 2026; src/home/CriticalNewsCard.tsx): the first reports of the last two
// days of a theft a notice tells HIGH whatever is held, each with its victim, token and sum, the market's last shock,
// and that the way after a hack is not measured.

vi.mock('electron', () => ({}))

async function render(element: ReactElement): Promise<string> {
  const { I18nProvider } = await import('../src/i18n/I18nProvider')
  const { ThemeProvider } = await import('../src/theme/ThemeContext')
  const html = renderToStaticMarkup(createElement(ThemeProvider, null, createElement(I18nProvider, { language: 'en' }, element)))
  return html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

const NOW = Date.parse('2026-10-30T09:00:00Z') / 1000

const report = (id: string, publishedAt: number, incident: Partial<StoryIncident> | null, title = 'A headline'): ReadStory =>
  ({
    id,
    title,
    url: `https://decrypt.co/${id}`,
    publishedAt,
    incident: incident === null ? null : { report: 'first', why: null, victim: null, victimToken: null, topExchange: false, amountUsd: null, ...incident }
  }) as unknown as ReadStory

describe("Home's critical news", () => {
  it('keeps the first reports of two days a notice tells HIGH, newest first, a late reading kept', () => {
    const binance = report('a', NOW - 11 * 3600, { victim: 'Binance', victimToken: 'BNB', topExchange: true, amountUsd: 5.5e9 })
    const initia = report('b', NOW - 3600, { victim: 'Initia', victimToken: 'INIT' })
    const unnamed = report('c', NOW - 2 * 3600, { amountUsd: 106e6 })
    const mercado = report('d', NOW - 3600, { victim: 'Mercado Bitcoin', amountUsd: 40e6 })
    const followUp = report('e', NOW - 3600, { report: 'follow-up', why: 'told before', victim: 'Binance', victimToken: 'BNB', topExchange: true })
    const old = report('f', NOW - 2 * 86_400 - 60, { victim: 'Bybit', topExchange: true })
    const none = report('g', NOW - 60, null)
    expect(loudFirstReports([binance, initia, unnamed, mercado, followUp, old, none], NOW).map((story) => story.id)).toEqual(['b', 'c', 'a'])
  })

  it('shows each with its victim, token, sum and time, the last shock, and that the way is unknown', async () => {
    const { CriticalNewsView } = await import('../src/home/CriticalNewsCard')
    const html = await render(
      createElement(CriticalNewsView, {
        reports: [
          report('a', Date.parse('2026-10-29T21:36:00Z') / 1000, { victim: 'Binance', victimToken: 'BNB', topExchange: true, amountUsd: 5.5e9 }, 'Binance Drained of $5.5 Billion in Suspected Hack'),
          report('b', Date.parse('2026-11-02T17:21:00Z') / 1000, { amountUsd: 106e6 }, 'EU entity suspected of losing $106 million')
        ],
        shock: { at: Date.parse('2026-10-29T19:45:00Z') / 1000, title: 'HIGH: market shock · in a liquidation cascade' }
      })
    )
    expect(html).toContain('Critical news')
    expect(html).toContain('<strong>Binance (BNB)</strong> · $5.5B · 21:36 UTC')
    expect(html).toContain('Binance Drained of $5.5 Billion in Suspected Hack')
    expect(html).toContain('<strong>Victim not named</strong> · $106M · 17:21 UTC')
    expect(html).toContain('Last market shock: 19:45 UTC. HIGH: market shock · in a liquidation cascade')
    expect(html).toContain('Which way: unknown. On 24 hacks of 2024 to 2026, a short of the victim\'s own token from the second day made money in 12 and lost in 12: no way to trade it.')
    expect(html).not.toContain('No first report')
  })

  it('says when there is none, and nothing before the feed is read', async () => {
    const { CriticalNewsView } = await import('../src/home/CriticalNewsCard')
    expect(await render(createElement(CriticalNewsView, { reports: [], shock: null }))).toContain('No first report of a large theft in the last two days.')
    expect(await render(createElement(CriticalNewsView, { reports: null, shock: null }))).not.toContain('No first report')
  })
})
