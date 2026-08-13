import {
  Wallet,
  ArrowLeftRight,
  Bot,
  Activity,
  Boxes,
  Anchor,
  Atom,
  Repeat,
  CandlestickChart,
  Compass,
  History,
  Settings,
  type LucideIcon
} from 'lucide-react'

export type Page =
  | 'portfolio'
  | 'trade'
  | 'bots'
  | 'executors'
  | 'controllers'
  | 'positions'
  | 'agents'
  | 'routines'
  | 'market'
  | 'backtest'
  | 'explorer'
  | 'settings'

export interface NavItem {
  page: Page
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { page: 'portfolio', label: 'Portfolio', icon: Wallet },
  { page: 'trade', label: 'Trade', icon: ArrowLeftRight },
  { page: 'bots', label: 'Bots', icon: Bot },
  { page: 'executors', label: 'Executors', icon: Activity },
  { page: 'controllers', label: 'Controllers', icon: Boxes },
  { page: 'positions', label: 'Positions', icon: Anchor },
  { page: 'agents', label: 'Agents', icon: Atom },
  { page: 'routines', label: 'Routines', icon: Repeat },
  { page: 'market', label: 'Market', icon: CandlestickChart },
  { page: 'backtest', label: 'Backtest', icon: History },
  { page: 'explorer', label: 'Explorer', icon: Compass },
  { page: 'settings', label: 'Settings', icon: Settings }
]
