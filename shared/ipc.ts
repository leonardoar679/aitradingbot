// Single source of truth for IPC channel names and payload shapes.
// Imported by both electron/ (main + preload) and src/ (renderer).

export const IpcChannel = {
  AppPing: 'app:ping',
  AppGetVersion: 'app:getVersion',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  MarketSubscribe: 'market:subscribe',
  MarketUnsubscribe: 'market:unsubscribe',
  MarketPriceUpdate: 'market:priceUpdate'
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface AppSettings {
  theme: 'light' | 'dark'
  apiKey: string | null
}

export interface PriceUpdate {
  symbol: string
  price: number
  timestamp: number
}
