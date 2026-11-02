import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel, type ForecastHistory, type ForecastReplayState, type ForecastState } from '../../../shared/ipc'
import type { PricePrediction } from '../../../shared/forecast/prediction'
import { getForecastDataStatus } from '../../services/forecastDataService'
import { forecastDecision, forecastHistory, forecastOf, forecastRanking, getForecastEngineState, latestForecasts, onForecastUpdate, forecastDayMoves } from '../../services/forecastService'
import type { ForecastRanking } from '../../../shared/forecast/ranking'
import type { TradeDecision } from '../../../shared/forecast/tradeDecision'
import { getForecastTrainingState, rollbackForecastRun } from '../../services/forecastTrainingService'
import { forecastBars, forecastRecordSpan, forecastReplay, getForecastLab } from '../../services/forecastLabService'
import type { ForecastLabView, ForecastReplay } from '../../../shared/forecast/labView'
import type { Candle } from '../../../shared/ipc'
import type { RoundTrip } from '../../../shared/venueCosts'
import { venueCostOf } from '../../services/venueQuotesService'
import { getForecastReplayState } from '../../services/forecastReplayService'

// The price forecast (the V6 document; V6 Stage 7): what it stands at, every pair's latest forecast,
// one pair's, and a pair's record; and the Forecast Lab (V6 Stage 11): the walk forward's and the live
// record's figures, a tested hour replayed, a pair's bars for the strategies set beside it. Nothing
// here can spend money or place an order: the forecast is made from public market data, and these
// channels only read it. A forecast's update is pushed as a
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
  ipcMain.handle(IpcChannel.ForecastRanking, (): ForecastRanking => forecastRanking())
  ipcMain.handle(IpcChannel.ForecastDecision, (_event, symbol: unknown): TradeDecision | null => forecastDecision(symbol))
  // A pair's round trip on each venue now, a buy or (V8 Stage 3) a sell at the reference stake (V7.2-R Stage 4): null
  // where no book is held.
  ipcMain.handle(IpcChannel.ForecastVenueCosts, (_event, symbol: unknown, side: unknown): { trips: RoundTrip[]; cheapest: RoundTrip | null; at: number } | null =>
    typeof symbol === 'string' ? venueCostOf(symbol, side === 'SELL' ? 'SELL' : 'BUY') : null
  )
  ipcMain.handle(IpcChannel.ForecastLab, (): Promise<ForecastLabView> => getForecastLab())
  ipcMain.handle(IpcChannel.ForecastReplay, (_event, pair: unknown, t: unknown): Promise<ForecastReplay | null> => forecastReplay(pair, t))
  ipcMain.handle(IpcChannel.ForecastOutOfSample, (): ForecastReplayState => getForecastReplayState())
  ipcMain.handle(IpcChannel.ForecastBars, (_event, pair: unknown, width: unknown, fromSec: unknown, toSec: unknown): Promise<Candle[]> => forecastBars(pair, width, fromSec, toSec))
  ipcMain.handle(IpcChannel.ForecastDayMoves, () => forecastDayMoves())
  ipcMain.handle(IpcChannel.ForecastRecord, (_event, fromSec: unknown, toSec: unknown): Promise<ForecastHistory> => forecastRecordSpan(fromSec, toSec))
  // Champion and challenger (V7.1 Stage 13): the run before the one in use put back, by a person; it moves
  // models and verdicts and nothing else -- no key, no cap, no kill switch, no strategy.
  ipcMain.handle(IpcChannel.ForecastRollback, (): Promise<{ ok: boolean; error: string | null }> => rollbackForecastRun())
}
