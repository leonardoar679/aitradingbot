import type { BrowserWindow } from 'electron'
import { registerAppHandlers } from './handlers/appHandlers'
import { registerSettingsHandlers } from './handlers/settingsHandlers'
import { registerMarketHandlers } from './handlers/marketHandlers'
import { registerCredentialsHandlers } from './handlers/credentialsHandlers'
import { registerLiveTradingHandlers } from './handlers/liveTradingHandlers'
import { registerBacktestHandlers } from './handlers/backtestHandlers'
import { registerAiHandlers } from './handlers/aiHandlers'

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  registerAppHandlers()
  registerSettingsHandlers()
  registerMarketHandlers(mainWindow)
  registerCredentialsHandlers()
  registerAiHandlers(mainWindow)
  registerLiveTradingHandlers()
  registerBacktestHandlers(mainWindow)
}
