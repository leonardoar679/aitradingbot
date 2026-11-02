import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE,
  DEFAULT_TABS,
  NAV_GROUPS,
  NAV_ITEMS,
  NORMAL_NAV_GROUPS,
  navGroupsFor,
  activeNavId,
  anchorElementId,
  foldedCount,
  groupOf,
  isGroupOpen,
  pageLabel,
  type NavGroupId,
  type Page
} from '../src/navigation/pages'
import { DEFAULT_UI_MODE, healUiMode } from '../shared/uiMode'

// The sidebar has the V6 document's two personalities (§64-65, §116; 13 October 2026), and
// docs/INVENTORY.md says where every card of the old pages went. These tests hold the two to each
// other: a page renamed in one and not the other, or a page left with nothing on it, fails here.

const ALL_PAGES: Page[] = [
  'home',
  'predictions',
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
  'forecast-lab',
  'discovery',
  'news-urls',
  'copy-traders',
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
  it('has the five groups of the V6 layout, in order, and only Research and All Features fold', () => {
    expect(NAV_GROUPS.map((group) => group.title)).toEqual(['AI Trader', 'Trading', 'Research', 'All Features', 'System'])
    expect(NAV_GROUPS.map((group) => group.items.map((item) => item.label))).toEqual([
      ['Home', 'Predictions', 'Opportunities', 'Positions', 'Performance'],
      ['Paper', 'Live'],
      ['Backtest', 'Forecast Lab', 'AI Benchmark', 'News URLs', 'Copy Traders'],
      ['Strategies', 'Bots', 'Executors', 'Controllers', 'Routines', 'Market', 'Portfolio', 'Explorer', 'Overview', 'AI Decisions'],
      ['Risk', 'Connections', 'Settings']
    ])
    expect(NAV_GROUPS.filter((group) => group.foldable).map((group) => group.id)).toEqual(['research', 'all-features'])
  })

  it('reaches every page, each entry once under its own label and id', () => {
    expect([...new Set(NAV_ITEMS.map((item) => item.target.page))].sort()).toEqual([...ALL_PAGES].sort())
    expect(new Set(NAV_ITEMS.map((item) => item.label)).size).toBe(NAV_ITEMS.length)
    expect(new Set(NAV_ITEMS.map((item) => item.id)).size).toBe(NAV_ITEMS.length)
    for (const page of ALL_PAGES) expect(pageLabel(page)).not.toBe(page)
  })

  it('opens the shortcut entries where that part of the app lives', () => {
    const target = (id: string): unknown => NAV_ITEMS.find((item) => item.id === id)?.target
    expect(target('bots')).toEqual({ page: 'strategies', tab: 'runs' })
    expect(target('executors')).toEqual({ page: 'strategies', tab: 'execution' })
    expect(target('controllers')).toEqual({ page: 'risk', anchor: 'controllers' })
    expect(target('routines')).toEqual({ page: 'research', tab: 'automation' })
    expect(target('portfolio')).toEqual({ page: 'performance', anchor: 'portfolio' })
    expect(target('explorer')).toEqual({ page: 'discovery' })
    expect(target('market')).toEqual({ page: 'markets' })
    expect(anchorElementId('controllers')).toBe('nav-anchor-controllers')
  })

  it('opens on Home, each page with views on a view it has', () => {
    expect(DEFAULT_PAGE).toBe('home')
    expect(Object.keys(DEFAULT_TABS).every((page) => (ALL_PAGES as string[]).includes(page))).toBe(true)
    expect(DEFAULT_TABS).toEqual({ strategies: 'runs', research: 'backtest', 'ai-decisions': 'analyze', discovery: 'scanner' })
  })

  it('a page is named by its plain entry, not a shortcut into it', () => {
    expect(pageLabel('strategies')).toBe('Strategies')
    expect(pageLabel('risk')).toBe('Risk')
    expect(pageLabel('performance')).toBe('Performance')
    expect(pageLabel('research')).toBe('Backtest')
    expect(pageLabel('discovery')).toBe('Explorer')
  })
})

// V7.2-R Stage 3 (20 October 2026; the user's plan, its seventh priority): the normal mode's own layout.
describe("the normal mode's sidebar", () => {
  it('leads with the pages a trader opens, folds every other entry under Advanced, and keeps System', () => {
    expect(navGroupsFor('normal')).toBe(NORMAL_NAV_GROUPS)
    expect(navGroupsFor('expert')).toBe(NAV_GROUPS)
    // Advanced is its own key, not the Settings page's advanced settings (V8 Stage 10).
    expect(NORMAL_NAV_GROUPS.map((group) => [group.id, group.title, group.foldable])).toEqual([
      ['main', 'AI Trader', false],
      ['more', 'Advanced@@the sidebar group of every other page', true],
      ['system', 'System', false]
    ])
    // The plan's sidebar since V8 Stage 10: News URLs after Predictions since Stage 5, Copy Traders after it since
    // Stage 8, and Explorer's News under Advanced.
    expect(NORMAL_NAV_GROUPS[0].items.map((item) => item.label)).toEqual(['Home', 'Predictions', 'News URLs', 'Copy Traders', 'Paper Trading', 'Performance'])
    expect(NORMAL_NAV_GROUPS[0].items.map((item) => item.target)).toEqual([{ page: 'home' }, { page: 'predictions' }, { page: 'news-urls' }, { page: 'copy-traders' }, { page: 'paper-trading' }, { page: 'performance' }])
    expect(NORMAL_NAV_GROUPS[1].items.map((item) => item.id).slice(13, 15)).toEqual(['explorer', 'news'])
    expect(groupOf('news-urls', 'normal')).toBe('main')
    expect(groupOf('copy-traders', 'normal')).toBe('main')
  })

  it('removes nothing: every entry of the expert layout is in it, once, under its own label but one renamed', () => {
    const normal = NORMAL_NAV_GROUPS.flatMap((group) => group.items)
    for (const item of NAV_ITEMS) expect(normal.filter((entry) => entry.id === item.id), item.id).toHaveLength(1)
    expect(new Set(normal.map((item) => item.id)).size).toBe(normal.length)
    expect([...new Set(normal.map((item) => item.target.page))].sort()).toEqual([...ALL_PAGES].sort())
    expect(normal.filter((item) => NAV_ITEMS.some((entry) => entry.id === item.id && entry.label !== item.label)).map((item) => item.label)).toEqual(['Paper Trading'])
  })

  it('lights the entry and opens the group the app is at in its own layout', () => {
    expect(activeNavId('discovery', { ...DEFAULT_TABS, discovery: 'news' }, null, 'normal')).toBe('news')
    expect(groupOf('news', 'normal')).toBe('more')
    expect(activeNavId('discovery', { ...DEFAULT_TABS, discovery: 'scanner' }, null, 'normal')).toBe('explorer')
    // The expert layout has no News entry: Explorer stays lit on its news tab.
    expect(activeNavId('discovery', { ...DEFAULT_TABS, discovery: 'news' }, null)).toBe('explorer')
    expect(groupOf('forecast-lab', 'normal')).toBe('more')
    expect(groupOf('forecast-lab')).toBe('research')
    expect(groupOf('paper', 'normal')).toBe('main')
    const more = NORMAL_NAV_GROUPS[1]
    expect(isGroupOpen(more, 'normal', new Set<NavGroupId>(), null)).toBe(false)
    expect(isGroupOpen(more, 'normal', new Set<NavGroupId>(), 'more')).toBe(true)
    expect(foldedCount(more, false, { discovery: 2 })).toBe(2)
  })
})

describe('the current entry', () => {
  it('is the one chosen while it still describes where the app is', () => {
    expect(activeNavId('strategies', { ...DEFAULT_TABS, strategies: 'runs' }, 'strategies')).toBe('strategies')
    expect(activeNavId('strategies', { ...DEFAULT_TABS, strategies: 'runs' }, 'bots')).toBe('bots')
    expect(activeNavId('risk', DEFAULT_TABS, 'controllers')).toBe('controllers')
    expect(activeNavId('performance', DEFAULT_TABS, 'portfolio')).toBe('portfolio')
  })

  it("is the page's view's entry after a hand-off moved the app elsewhere", () => {
    // A call's order form opens Strategies on Execution: Executors, though Bots was chosen last.
    expect(activeNavId('strategies', { ...DEFAULT_TABS, strategies: 'execution' }, 'bots')).toBe('executors')
    expect(activeNavId('research', { ...DEFAULT_TABS, research: 'automation' }, 'backtest')).toBe('routines')
    // A page with no view of its own falls to its plain entry, whatever was chosen elsewhere.
    expect(activeNavId('risk', DEFAULT_TABS, 'home')).toBe('risk')
    expect(activeNavId('home', DEFAULT_TABS, null)).toBe('home')
  })

  it('names its group', () => {
    expect(groupOf('explorer')).toBe('all-features')
    expect(groupOf('home')).toBe('ai-trader')
    expect(groupOf('backtest')).toBe('research')
  })
})

describe('folding', () => {
  const research = NAV_GROUPS.find((group) => group.id === 'research')!
  const trading = NAV_GROUPS.find((group) => group.id === 'trading')!
  const none = new Set<NavGroupId>()

  it('folds Research and All Features in the normal mode, opens them in the expert one', () => {
    expect(isGroupOpen(research, 'normal', none, null)).toBe(false)
    expect(isGroupOpen(research, 'expert', none, null)).toBe(true)
    expect(isGroupOpen(trading, 'normal', none, null)).toBe(true)
  })

  it('opens a folded group that was opened, or that holds the current entry', () => {
    expect(isGroupOpen(research, 'normal', new Set<NavGroupId>(['research']), null)).toBe(true)
    expect(isGroupOpen(research, 'normal', none, 'research')).toBe(true)
    expect(isGroupOpen(research, 'normal', none, 'all-features')).toBe(false)
  })

  it('a folded group carries the counts of the entries it hides, and an open one none', () => {
    const all = NAV_GROUPS.find((group) => group.id === 'all-features')!
    expect(foldedCount(all, false, { discovery: 3 })).toBe(3)
    expect(foldedCount(all, true, { discovery: 3 })).toBe(0)
    expect(foldedCount(research, false, { discovery: 3 })).toBe(0)
  })

  it('reads a stored mode as normal unless it says expert', () => {
    expect(DEFAULT_UI_MODE).toBe('normal')
    expect(healUiMode('expert')).toBe('expert')
    for (const stored of [undefined, null, 'Expert', 'normal', 1, {}]) expect(healUiMode(stored)).toBe('normal')
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

  it('leaves no entry in the sidebar with nothing on it', () => {
    for (const label of labels) {
      expect(
        homes.some((home) => home.includes(label)),
        label
      ).toBe(true)
    }
  })
})
