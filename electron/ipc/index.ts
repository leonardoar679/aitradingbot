import type { BrowserWindow } from 'electron'
import { registerAppHandlers } from './handlers/appHandlers'
import { registerSettingsHandlers } from './handlers/settingsHandlers'
import { registerMarketHandlers } from './handlers/marketHandlers'
import { registerScannerHandlers } from './handlers/scannerHandlers'
import { registerResearchHandlers } from './handlers/researchHandlers'
import { registerLiveMarketHandlers } from './handlers/liveMarketHandlers'
import { registerNewsFeedHandlers } from './handlers/newsFeedHandlers'
import { registerForecastHandlers } from './handlers/forecastHandlers'
import { registerNewsHandlers } from './handlers/newsHandlers'
import { registerCredentialsHandlers } from './handlers/credentialsHandlers'
import { registerLiveTradingHandlers } from './handlers/liveTradingHandlers'
import { registerDemoTradingHandlers } from './handlers/demoTradingHandlers'
import { registerBacktestHandlers } from './handlers/backtestHandlers'
import { registerAiHandlers } from './handlers/aiHandlers'
import { registerRecordHandlers } from './handlers/recordHandlers'
import { registerHealthHandlers } from './handlers/healthHandlers'
import { registerExperimentHandlers } from './handlers/experimentHandlers'

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  registerAppHandlers()
  registerRecordHandlers()
  registerExperimentHandlers(mainWindow)
  registerSettingsHandlers()
  registerMarketHandlers(mainWindow)
  registerScannerHandlers(mainWindow)
  registerResearchHandlers(mainWindow)
  registerLiveMarketHandlers(mainWindow)
  registerHealthHandlers(mainWindow)
  registerNewsFeedHandlers(mainWindow)
  registerForecastHandlers(mainWindow)
  registerNewsHandlers(mainWindow)
  registerCredentialsHandlers()
  registerAiHandlers(mainWindow)
  registerLiveTradingHandlers()
  registerDemoTradingHandlers()
  registerBacktestHandlers(mainWindow)
}
