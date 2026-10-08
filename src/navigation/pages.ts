import {
  LayoutDashboard,
  Radar,
  CandlestickChart,
  Atom,
  Anchor,
  TrendingUp,
  ArrowLeftRight,
  Zap,
  Boxes,
  History,
  Scale,
  Compass,
  ShieldCheck,
  KeyRound,
  Settings,
  type LucideIcon
} from 'lucide-react'

// The sidebar follows a trade, not the order the app was built in: what is happening and what to
// do about it, then trading it, then research, then the system. Every page the app had before
// this layout still exists inside one of these -- docs/INVENTORY.md says where each one went.

export type Page =
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

/** The pages that hold more than one view, and the views each opens on. */
export type StrategiesTab = 'runs' | 'execution'
export type ResearchTab = 'backtest' | 'automation'
export type AiDecisionsTab = 'analyze' | 'signals'
export type DiscoveryTab = 'scanner' | 'news'

export interface PageTabs {
  strategies: StrategiesTab
  research: ResearchTab
  'ai-decisions': AiDecisionsTab
  discovery: DiscoveryTab
}

export const DEFAULT_TABS: PageTabs = { strategies: 'runs', research: 'backtest', 'ai-decisions': 'analyze', discovery: 'scanner' }

/** Where to go: a page, and for a page with views, which one. A hand-off between pages names the
 * view it lands on, so a call's filled-in order form opens where the form is. */
export type NavTarget =
  | { page: Exclude<Page, keyof PageTabs> }
  | { page: 'strategies'; tab?: StrategiesTab }
  | { page: 'research'; tab?: ResearchTab }
  | { page: 'ai-decisions'; tab?: AiDecisionsTab }
  | { page: 'discovery'; tab?: DiscoveryTab }

export interface NavItem {
  page: Page
  label: string
  icon: LucideIcon
}

export interface NavGroup {
  title: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'AI Trader',
    items: [
      { page: 'overview', label: 'Overview', icon: LayoutDashboard },
      { page: 'opportunities', label: 'Opportunities', icon: Radar },
      { page: 'markets', label: 'Markets', icon: CandlestickChart },
      { page: 'ai-decisions', label: 'AI Decisions', icon: Atom },
      { page: 'positions', label: 'Positions', icon: Anchor },
      { page: 'performance', label: 'Performance', icon: TrendingUp }
    ]
  },
  {
    title: 'Research',
    items: [
      { page: 'research', label: 'Backtest & Research', icon: History },
      { page: 'ai-benchmark', label: 'AI Benchmark', icon: Scale },
      { page: 'discovery', label: 'Discovery', icon: Compass }
    ]
  },
  {
    title: 'Trading',
    items: [
      { page: 'paper-trading', label: 'Paper Trading', icon: ArrowLeftRight },
      { page: 'live-trading', label: 'Live Trading', icon: Zap },
      { page: 'strategies', label: 'Strategies', icon: Boxes }
    ]
  },
  {
    title: 'System',
    items: [
      { page: 'risk', label: 'Risk & Safety', icon: ShieldCheck },
      { page: 'connections', label: 'Connections', icon: KeyRound },
      { page: 'settings', label: 'Settings', icon: Settings }
    ]
  }
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

export function pageLabel(page: Page): string {
  return NAV_ITEMS.find((item) => item.page === page)?.label ?? page
}
