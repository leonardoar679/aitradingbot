import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TABS, NAV_GROUPS, NAV_ITEMS, pageLabel, type Page } from '../src/navigation/pages'

// The sidebar is arranged around a trade (the V3 document's layout, chosen on 2026-10-05), and
// docs/INVENTORY.md says where every card of the old pages went. These tests hold the two to each
// other: a page renamed in one and not the other, or a page left with nothing on it, fails here.

const ALL_PAGES: Page[] = [
  'overview',
  'opportunities',
  'markets',
  'ai-decisions',
  'positions',
  'performance',
  'paper-trading',
  'live-trading',
  'strategies',
  'research',
  'ai-benchmark',
  'discovery',
  'risk',
  'connections',
  'settings'
]

/** The "New home" column of the inventory's page table, one cell a row. */
function newHomes(): string[] {
  const inventory = readFileSync(join(__dirname, '..', 'docs', 'INVENTORY.md'), 'utf-8')
  const start = inventory.indexOf('## Pages, tabs and cards')
  const end = inventory.indexOf('\n## ', start + 1)
  const rows = inventory
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
  // The header row and the separator under it are not rows.
  return rows.filter((cells) => cells[4] !== 'New home' && !/^-+$/.test(cells[4])).map((cells) => cells[4])
}

describe('the sidebar', () => {
  it('has the four groups of the chosen layout, in order', () => {
    expect(NAV_GROUPS.map((group) => group.title)).toEqual(['AI Trader', 'Trading', 'Research', 'System'])
    expect(NAV_GROUPS.map((group) => group.items.map((item) => item.label))).toEqual([
      ['Overview', 'Opportunities', 'Markets', 'AI Decisions', 'Positions', 'Performance'],
      ['Paper Trading', 'Live Trading', 'Strategies'],
      ['Backtest & Research', 'AI Benchmark', 'Discovery'],
      ['Risk & Safety', 'Connections', 'Settings']
    ])
  })

  it('lists every page exactly once, each under its own label', () => {
    expect(NAV_ITEMS.map((item) => item.page).sort()).toEqual([...ALL_PAGES].sort())
    expect(new Set(NAV_ITEMS.map((item) => item.label)).size).toBe(NAV_ITEMS.length)
    for (const page of ALL_PAGES) expect(pageLabel(page)).not.toBe(page)
  })

  it('opens each page that has views on a view it has', () => {
    expect(Object.keys(DEFAULT_TABS).every((page) => (ALL_PAGES as string[]).includes(page))).toBe(true)
    expect(DEFAULT_TABS).toEqual({ strategies: 'runs', research: 'backtest', 'ai-decisions': 'analyze', discovery: 'scanner' })
  })
})

describe('the inventory and the sidebar agree', () => {
  const homes = newHomes()
  const labels = NAV_ITEMS.map((item) => item.label)

  it('reads the inventory it is checking', () => {
    // A parse that silently found nothing would pass both tests below.
    expect(homes.length).toBeGreaterThan(30)
  })

  it('sends every card of the old pages to a page that exists', () => {
    for (const home of homes) {
      expect(
        labels.some((label) => home.includes(label)),
        home
      ).toBe(true)
    }
  })

  it('leaves no page in the sidebar with nothing on it', () => {
    for (const label of labels) {
      expect(
        homes.some((home) => home.includes(label)),
        label
      ).toBe(true)
    }
  })
})
