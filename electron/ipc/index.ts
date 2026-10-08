import type { BrowserWindow } from 'electron'
import { registerAppHandlers } from './handlers/appHandlers'
import { registerSettingsHandlers } from './handlers/settingsHandlers'
import { registerMarketHandlers } from './handlers/marketHandlers'
import { registerScannerHandlers } from './handlers/scannerHandlers'
import { registerResearchHandlers } from './handlers/researchHandlers'
import { registerLiveMarketHandlers } from './handlers/liveMarketHandlers'
import { registerNewsFeedHandlers } from './handlers/newsFeedHandlers'
import { registerNewsHandlers } from './handlers/newsHandlers'
import { registerCredentialsHandlers } from './handlers/credentialsHandlers'
import { registerLiveTradingHandlers } from './handlers/liveTradingHandlers'
import { registerBacktestHandlers } from './handlers/backtestHandlers'
import { registerAiHandlers } from './handlers/aiHandlers'
import { registerRecordHandlers } from './handlers/recordHandlers'

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  registerAppHandlers()
  registerRecordHandlers()
  registerSettingsHandlers()
  registerMarketHandlers(mainWindow)
  registerScannerHandlers(mainWindow)
  registerResearchHandlers(mainWindow)
  registerLiveMarketHandlers(mainWindow)
  registerNewsFeedHandlers(mainWindow)
  registerNewsHandlers(mainWindow)
  registerCredentialsHandlers()
  registerAiHandlers(mainWindow)
  registerLiveTradingHandlers()
  registerBacktestHandlers(mainWindow)
}
