import {
  House,
  LayoutDashboard,
  Radar,
  CandlestickChart,
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
  type LucideIcon
} from 'lucide-react'
import type { UiMode } from '../../shared/uiMode'

// The sidebar has two personalities (the V6 document, §64-65 and §116; 13 October 2026). The normal
// path runs AI TRADER -> TRADING: the prediction, the opportunity, the position, paper or live. The
// rest is RESEARCH and ALL FEATURES, folded away in the normal mode and open in the expert one.
// Nothing is removed: every page the app had before this layout is in it, some under a name of the
// document's (Explorer for Discovery, Market for Markets), and the document's separate entries for
// what this app keeps together -- Bots and Executors are Strategies' two views, Controllers sits on
// Risk & Safety, Routines on Backtest's Automation, Portfolio on Performance -- open the page where
// that part lives. docs/INVENTORY.md says where every card of the old pages went.

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
  | 'discovery'
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

export interface NavItem {
  id: NavId
  label: string
  icon: LucideIcon
  target: NavTarget
}

export type NavGroupId = 'ai-trader' | 'trading' | 'research' | 'all-features' | 'system'

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
    title: 'AI Trader',
    foldable: false,
    icon: House,
    items: [
      { id: 'home', label: 'Home', icon: House, target: { page: 'home' } },
      { id: 'predictions', label: 'Predictions', icon: Telescope, target: { page: 'predictions' } },
      { id: 'opportunities', label: 'Opportunities', icon: Radar, target: { page: 'opportunities' } },
      { id: 'positions', label: 'Positions', icon: Anchor, target: { page: 'positions' } },
      { id: 'performance', label: 'Performance', icon: TrendingUp, target: { page: 'performance' } }
    ]
  },
  {
    id: 'trading',
    title: 'Trading',
    foldable: false,
    icon: ArrowLeftRight,
    items: [
      { id: 'paper', label: 'Paper', icon: ArrowLeftRight, target: { page: 'paper-trading' } },
      { id: 'live', label: 'Live', icon: Zap, target: { page: 'live-trading' } }
    ]
  },
  {
    id: 'research',
    title: 'Research',
    foldable: true,
    icon: History,
    items: [
      { id: 'backtest', label: 'Backtest', icon: History, target: { page: 'research', tab: 'backtest' } },
      { id: 'ai-benchmark', label: 'AI Benchmark', icon: Scale, target: { page: 'ai-benchmark' } }
    ]
  },
  {
    id: 'all-features',
    title: 'All Features',
    foldable: true,
    icon: Layers,
    items: [
      { id: 'strategies', label: 'Strategies', icon: Boxes, target: { page: 'strategies' } },
      { id: 'bots', label: 'Bots', icon: Bot, target: { page: 'strategies', tab: 'runs' } },
      { id: 'executors', label: 'Executors', icon: Cpu, target: { page: 'strategies', tab: 'execution' } },
      { id: 'controllers', label: 'Controllers', icon: Layers, target: { page: 'risk', anchor: 'controllers' } },
      { id: 'routines', label: 'Routines', icon: Repeat, target: { page: 'research', tab: 'automation' } },
      { id: 'market', label: 'Market', icon: CandlestickChart, target: { page: 'markets' } },
      { id: 'portfolio', label: 'Portfolio', icon: Wallet, target: { page: 'performance', anchor: 'portfolio' } },
      { id: 'explorer', label: 'Explorer', icon: Compass, target: { page: 'discovery' } },
      { id: 'overview', label: 'Overview', icon: LayoutDashboard, target: { page: 'overview' } },
      { id: 'ai-decisions', label: 'AI Decisions', icon: Atom, target: { page: 'ai-decisions' } }
    ]
  },
  {
    id: 'system',
    title: 'System',
    foldable: false,
    icon: Settings,
    items: [
      { id: 'risk', label: 'Risk', icon: ShieldCheck, target: { page: 'risk' } },
      { id: 'connections', label: 'Connections', icon: KeyRound, target: { page: 'connections' } },
      { id: 'settings', label: 'Settings', icon: Settings, target: { page: 'settings' } }
    ]
  }
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

/** The first entry that opens a page plainly, or the first that opens it at all. */
function firstItemFor(page: Page): NavItem | undefined {
  const items = NAV_ITEMS.filter((item) => item.target.page === page)
  return items.find((item) => !('tab' in item.target && item.target.tab !== undefined) && item.target.anchor === undefined) ?? items[0]
}

/** What a page is called where a message names it: its sidebar entry's label. */
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
export function activeNavId(page: Page, tabs: PageTabs, chosen: NavId | null): NavId | null {
  const tab = currentTab(page, tabs)
  const fits = (item: NavItem): boolean => item.target.page === page && (tabOf(item.target) === undefined || tabOf(item.target) === tab)
  const last = chosen === null ? undefined : NAV_ITEMS.find((item) => item.id === chosen)
  if (last !== undefined && fits(last)) return last.id
  const byView = NAV_ITEMS.find((item) => item.target.page === page && tab !== undefined && tabOf(item.target) === tab)
  return byView?.id ?? firstItemFor(page)?.id ?? null
}

/** The group an entry is in. */
export function groupOf(id: NavId): NavGroupId | null {
  return NAV_GROUPS.find((group) => group.items.some((item) => item.id === id))?.id ?? null
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
  return group.items.reduce((sum, item) => sum + (badges[item.target.page] ?? 0), 0)
}
