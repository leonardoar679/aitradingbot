import { LayoutDashboard, Bot, Compass, History, Settings, type LucideIcon } from 'lucide-react'

export type Page = 'dashboard' | 'bots' | 'explorer' | 'backtest' | 'settings'

export interface NavItem {
  page: Page
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { page: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { page: 'bots', label: 'Bots', icon: Bot },
  { page: 'backtest', label: 'Backtest', icon: History },
  { page: 'explorer', label: 'Explorer', icon: Compass },
  { page: 'settings', label: 'Settings', icon: Settings }
]
