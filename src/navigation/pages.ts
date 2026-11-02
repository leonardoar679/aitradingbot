import {
  House,
  LayoutDashboard,
  Radar,
  CandlestickChart,
  ChartSpline,
  Atom,
  Anchor,
  TrendingUp,
  ArrowLeftRight,
  Zap,
  Boxes,
  Bot,
  Cpu,
  Layers,
  Repeat,
  Wallet,
  History,
  Scale,
  Compass,
  ShieldCheck,
  KeyRound,
  Settings,
  Telescope,
  Newspaper,
  Link2,
  UserRoundSearch,
  type LucideIcon
} from 'lucide-react'
import type { UiMode } from '../../shared/uiMode'
import { msg } from '../../shared/i18n/translate'

// The sidebar has two personalities (the V6 document, §64-65 and §116; 13 October 2026). The normal
// path runs AI TRADER -> TRADING: the prediction, the opportunity, the position, paper or live. The
// rest is RESEARCH and ALL FEATURES, folded away in the normal mode and open in the expert one.
// Nothing is removed: every page the app had before this layout is in it, some under a name of the
// document's (Explorer for Discovery, Market for Markets), and the document's separate entries for
// what this app keeps together -- Bots and Executors are Strategies' two views, Controllers sits on
// Risk & Safety, Routines on Backtest's Automation, Portfolio on Performance -- open the page where
// that part lives. docs/INVENTORY.md says where every card of the old pages went.
//
// Since V7.2-R Stage 3 (20 October 2026; the user's plan of that day, its seventh priority) the normal mode has a
// layout of its own (NORMAL_NAV_GROUPS): the pages a trader opens -- since V8 Stage 10 Home, Predictions, News URLs,
// Copy Traders, Paper Trading and Performance -- then every other entry under Advanced, Explorer's News among them,
// folded until opened, and System as it was.
// The expert mode keeps the layout above (NAV_GROUPS). Nothing is removed from either.

export type Page =
  | 'home'
  | 'predictions'
  | 'overview'
  | 'opportunities'
  | 'markets'
  | 'ai-decisions'
  | 'positions'
  | 'performance'
  | 'paper-trading'
  | 'live-trading'
  | 'strategies'
  | 'research'
  | 'ai-benchmark'
  | 'forecast-lab'
  | 'discovery'
  | 'news-urls'
  | 'copy-traders'
  | 'risk'
  | 'connections'
  | 'settings'

/** The page the app opens on (§3): the prediction first. */
export const DEFAULT_PAGE: Page = 'home'

/** The pages that hold more than one view, and the views each opens on. */
export type StrategiesTab = 'runs' | 'execution'
export type ResearchTab = 'backtest' | 'automation'
export type AiDecisionsTab = 'analyze' | 'signals' | 'events'
export type DiscoveryTab = 'scanner' | 'news'

export interface PageTabs {
  strategies: StrategiesTab
  research: ResearchTab
  'ai-decisions': AiDecisionsTab
  discovery: DiscoveryTab
}

export const DEFAULT_TABS: PageTabs = { strategies: 'runs', research: 'backtest', 'ai-decisions': 'analyze', discovery: 'scanner' }

/** A place on a page a sidebar entry opens at: the element with the id `nav-anchor-<anchor>`. */
export type NavAnchor = 'controllers' | 'portfolio'

export function anchorElementId(anchor: NavAnchor): string {
  return `nav-anchor-${anchor}`
}

/** Where to go: a page, and for a page with views, which one; and where on it, for an entry that
 * opens at a part of a page. A hand-off between pages names the view it lands on, so a call's
 * filled-in order form opens where the form is. */
export type NavTarget =
  | { page: Exclude<Page, keyof PageTabs>; anchor?: NavAnchor }
  | { page: 'strategies'; tab?: StrategiesTab; anchor?: NavAnchor }
  | { page: 'research'; tab?: ResearchTab; anchor?: NavAnchor }
  | { page: 'ai-decisions'; tab?: AiDecisionsTab; anchor?: NavAnchor }
  | { page: 'discovery'; tab?: DiscoveryTab; anchor?: NavAnchor }

export type NavId =
  | 'home'
  | 'predictions'
  | 'opportunities'
  | 'positions'
  | 'performance'
  | 'paper'
  | 'live'
  | 'backtest'
  | 'forecast-lab'
  | 'ai-benchmark'
  | 'strategies'
  | 'bots'
  | 'executors'
  | 'controllers'
  | 'routines'
  | 'market'
  | 'portfolio'
  | 'explorer'
  | 'overview'
  | 'ai-decisions'
  | 'risk'
  | 'connections'
  | 'settings'
  | 'news'
  | 'news-urls'
  | 'copy-traders'

export interface NavItem {
  id: NavId
  label: string
  icon: LucideIcon
  target: NavTarget
}

export type NavGroupId = 'ai-trader' | 'trading' | 'research' | 'all-features' | 'system' | 'main' | 'more'

export interface NavGroup {
  id: NavGroupId
  title: string
  /** Folded away in the normal mode until opened; always open in the expert one. */
  foldable: boolean
  /** The icon a folded group shows in the narrow sidebar. */
  icon: LucideIcon
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'ai-trader',
    title: msg('AI Trader'),
    foldable: false,
    icon: House,
    items: [
      { id: 'home', label: msg('Home'), icon: House, target: { page: 'home' } },
      { id: 'predictions', label: msg('Predictions'), icon: Telescope, target: { page: 'predictions' } },
      { id: 'opportunities', label: msg('Opportunities'), icon: Radar, target: { page: 'opportunities' } },
      { id: 'positions', label: msg('Positions'), icon: Anchor, target: { page: 'positions' } },
      { id: 'performance', label: msg('Performance'), icon: TrendingUp, target: { page: 'performance' } }
    ]
  },
  {
    id: 'trading',
    title: msg('Trading'),
    foldable: false,
    icon: ArrowLeftRight,
    items: [
      { id: 'paper', label: msg('Paper'), icon: ArrowLeftRight, target: { page: 'paper-trading' } },
      { id: 'live', label: msg('Live'), icon: Zap, target: { page: 'live-trading' } }
    ]
  },
  {
    id: 'research',
    title: msg('Research'),
    foldable: true,
    icon: History,
    items: [
      { id: 'backtest', label: msg('Backtest'), icon: History, target: { page: 'research', tab: 'backtest' } },
      { id: 'forecast-lab', label: msg('Forecast Lab'), icon: ChartSpline, target: { page: 'forecast-lab' } },
      { id: 'ai-benchmark', label: msg('AI Benchmark'), icon: Scale, target: { page: 'ai-benchmark' } },
      // A pasted news link read safely and kept (V8 Stage 4), translated and in the normal sidebar's main group since V8 Stage 5.
      { id: 'news-urls', label: msg('News URLs'), icon: Link2, target: { page: 'news-urls' } },
      // A pasted trader read, kept and judged (V8 Stage 6); English until V8 Stage 8.
      { id: 'copy-traders', label: msg('Copy Traders'), icon: UserRoundSearch, target: { page: 'copy-traders' } }
    ]
  },
  {
    id: 'all-features',
    title: msg('All Features'),
    foldable: true,
    icon: Layers,
    items: [
      { id: 'strategies', label: msg('Strategies'), icon: Boxes, target: { page: 'strategies' } },
      { id: 'bots', label: msg('Bots'), icon: Bot, target: { page: 'strategies', tab: 'runs' } },
      { id: 'executors', label: msg('Executors'), icon: Cpu, target: { page: 'strategies', tab: 'execution' } },
      { id: 'controllers', label: msg('Controllers'), icon: Layers, target: { page: 'risk', anchor: 'controllers' } },
      { id: 'routines', label: msg('Routines'), icon: Repeat, target: { page: 'research', tab: 'automation' } },
      { id: 'market', label: msg('Market'), icon: CandlestickChart, target: { page: 'markets' } },
      { id: 'portfolio', label: msg('Portfolio'), icon: Wallet, target: { page: 'performance', anchor: 'portfolio' } },
      { id: 'explorer', label: msg('Explorer'), icon: Compass, target: { page: 'discovery' } },
      { id: 'overview', label: msg('Overview'), icon: LayoutDashboard, target: { page: 'overview' } },
      { id: 'ai-decisions', label: msg('AI Decisions'), icon: Atom, target: { page: 'ai-decisions' } }
    ]
  },
  {
    id: 'system',
    title: msg('System'),
    foldable: false,
    icon: Settings,
    items: [
      { id: 'risk', label: msg('Risk'), icon: ShieldCheck, target: { page: 'risk' } },
      { id: 'connections', label: msg('Connections'), icon: KeyRound, target: { page: 'connections' } },
      { id: 'settings', label: msg('Settings'), icon: Settings, target: { page: 'settings' } }
    ]
  }
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

const itemById = (id: NavId): NavItem => {
  const item = NAV_ITEMS.find((entry) => entry.id === id)
  if (item === undefined) throw new Error(`No sidebar entry ${id}`)
  return item
}

/** The normal mode's own entry: Explorer's news, under Advanced since V8 Stage 10. */
const NEWS_ITEM: NavItem = { id: 'news', label: msg('News'), icon: Newspaper, target: { page: 'discovery', tab: 'news' } }

/** The entries Advanced holds in the normal mode, in the expert layout's order: every one not in the main group or
 * System; Explorer's News after Explorer. */
const MORE_FEATURES: NavId[] = ['opportunities', 'positions', 'live', 'backtest', 'forecast-lab', 'ai-benchmark', 'strategies', 'bots', 'executors', 'controllers', 'routines', 'market', 'portfolio', 'explorer', 'overview', 'ai-decisions']

/** The normal mode's sidebar (V7.2-R Stage 3); News URLs after Predictions since V8 Stage 5, Copy Traders after it since
 * Stage 8; since Stage 10 the six pages of the plan's sidebar -- Home, Predictions, News URLs, Copy Traders, Paper
 * Trading, Performance -- then Advanced: every other entry, Explorer's News among them. Advanced is a key of its own
 * (`Advanced@@...`): the Settings page's Advanced is its advanced settings, a different word in most languages. */
export const NORMAL_NAV_GROUPS: NavGroup[] = [
  {
    id: 'main',
    title: msg('AI Trader'),
    foldable: false,
    icon: House,
    items: [itemById('home'), itemById('predictions'), itemById('news-urls'), itemById('copy-traders'), { ...itemById('paper'), label: msg('Paper Trading') }, itemById('performance')]
  },
  {
    id: 'more',
    title: msg('Advanced@@the sidebar group of every other page'),
    foldable: true,
    icon: Layers,
    items: MORE_FEATURES.flatMap((id) => (id === 'explorer' ? [itemById(id), NEWS_ITEM] : [itemById(id)]))
  },
  NAV_GROUPS.find((group) => group.id === 'system')!
]

/** The sidebar's groups in a mode. */
export function navGroupsFor(mode: UiMode): NavGroup[] {
  return mode === 'expert' ? NAV_GROUPS : NORMAL_NAV_GROUPS
}

/** The entries a mode's sidebar shows. */
function itemsFor(mode: UiMode): NavItem[] {
  return mode === 'expert' ? NAV_ITEMS : NORMAL_NAV_GROUPS.flatMap((group) => group.items)
}

/** The first entry that opens a page plainly, or the first that opens it at all. */
function firstItemFor(page: Page, all: readonly NavItem[] = NAV_ITEMS): NavItem | undefined {
  const items = all.filter((item) => item.target.page === page)
  return items.find((item) => !('tab' in item.target && item.target.tab !== undefined) && item.target.anchor === undefined) ?? items[0]
}

/** What a page is called where a message names it: its sidebar entry's label, in English; a translated
 * place shows it through t(). */
export function pageLabel(page: Page): string {
  return firstItemFor(page)?.label ?? page
}

function tabOf(target: NavTarget): string | undefined {
  return 'tab' in target ? target.tab : undefined
}

/** The view a page is on now, for a page that has views. */
function currentTab(page: Page, tabs: PageTabs): string | undefined {
  return page in tabs ? tabs[page as keyof PageTabs] : undefined
}

/** The entry shown as the current one. The one last chosen, while it still describes where the app
 * is; otherwise the entry for the page's current view, then the page's plain entry. A hand-off that
 * opens Strategies on Execution lights Executors, and choosing Strategies lights Strategies. */
export function activeNavId(page: Page, tabs: PageTabs, chosen: NavId | null, mode: UiMode = 'expert'): NavId | null {
  const items = itemsFor(mode)
  const tab = currentTab(page, tabs)
  const fits = (item: NavItem): boolean => item.target.page === page && (tabOf(item.target) === undefined || tabOf(item.target) === tab)
  const last = chosen === null ? undefined : items.find((item) => item.id === chosen)
  if (last !== undefined && fits(last)) return last.id
  const byView = items.find((item) => item.target.page === page && tab !== undefined && tabOf(item.target) === tab)
  return byView?.id ?? firstItemFor(page, items)?.id ?? null
}

/** The group an entry is in, in a mode's sidebar. */
export function groupOf(id: NavId, mode: UiMode = 'expert'): NavGroupId | null {
  return navGroupsFor(mode).find((group) => group.items.some((item) => item.id === id))?.id ?? null
}

/** Whether a group is shown open: always when it does not fold or the mode is expert; otherwise when
 * it was opened, or when the current entry is inside it, so the place the app is at is never hidden. */
export function isGroupOpen(group: Pick<NavGroup, 'id' | 'foldable'>, mode: UiMode, opened: ReadonlySet<NavGroupId>, activeGroup: NavGroupId | null): boolean {
  if (!group.foldable || mode === 'expert') return true
  return opened.has(group.id) || activeGroup === group.id
}

/** What a folded group shows of the counts on the entries it hides -- an unseen alert on Explorer is
 * never out of sight; nothing while it is open, where each entry shows its own. */
export function foldedCount(group: Pick<NavGroup, 'items'>, open: boolean, badges: Partial<Record<Page, number>>): number {
  if (open) return 0
  // Each page once: Explorer and its News open one page (V8 Stage 10), whose badge is not two.
  return [...new Set(group.items.map((item) => item.target.page))].reduce((sum, page) => sum + (badges[page] ?? 0), 0)
}
