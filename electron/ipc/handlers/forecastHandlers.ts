import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel, type ForecastHistory, type ForecastState } from '../../../shared/ipc'
import type { PricePrediction } from '../../../shared/forecast/prediction'
import { getForecastDataStatus } from '../../services/forecastDataService'
import { forecastHistory, forecastOf, getForecastEngineState, latestForecasts, onForecastUpdate } from '../../services/forecastService'
import { getForecastTrainingState } from '../../services/forecastTrainingService'

// The price forecast (the V6 document; V6 Stage 7): what it stands at, every pair's latest forecast,
// one pair's, and a pair's record. Nothing here can spend money or place an order: the forecast is
// made from public market data, and these channels only read it. A forecast's update is pushed as a
// notice; the window asks for what it shows.
export function registerForecastHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onForecastUpdate(() => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.ForecastUpdate, getForecastEngineState().lastPassAt)
  })
  mainWindow.on('closed', stopForwarding)

  ipcMain.handle(IpcChannel.ForecastGetState, (): ForecastState => ({ engine: getForecastEngineState(), training: getForecastTrainingState(), data: getForecastDataStatus() }))
  ipcMain.handle(IpcChannel.ForecastList, (): PricePrediction[] => latestForecasts())
  ipcMain.handle(IpcChannel.ForecastGet, (_event, symbol: unknown): PricePrediction | null => forecastOf(symbol))
  ipcMain.handle(IpcChannel.ForecastHistory, (_event, symbol: unknown, fromSec: unknown): Promise<ForecastHistory> => forecastHistory(symbol, fromSec))
}
