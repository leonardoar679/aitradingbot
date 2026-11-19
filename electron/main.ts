import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { guardEveryWindow } from './windowGuard'
import type { OwnPage } from '../shared/navigationGuard'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { startResearchFolder } from './services/researchFolderService'
import { startVenueQuotes } from './services/venueQuotesService'
import { startPredictionLedger } from './services/predictionLedgerService'
import { startAccuracyBoard } from './services/accuracyBoardService'
import { startBookMarks } from './services/booksService'
import { startPrimaryCall } from './services/primaryCallService'
import { startNewsUrls } from './services/newsUrlService'
import { startFollowing, stopFollowing } from './services/followService'
import { startDiscovery, stopDiscovery } from './services/discoveryService'
import { startLivePositionWatcherLoop } from './services/livePositionWatchersService'
import { startLiveTwapLoop } from './services/liveTwapService'
import { startMarketScanner } from './services/marketScannerService'
import { startMarketResearch } from './services/marketResearchService'
import { setForecastMovers, startForecastData } from './services/forecastDataService'
import { scannerMovers } from '../shared/forecast/universe'
import { startForecastTraining } from './services/forecastTrainingService'
import { forecastClassVerdict, startForecastLab } from './services/forecastLabService'
import { startForecastReplay } from './services/forecastReplayService'
import { forecastLiveSignal, forecastNewsSignal, forecastScannerSignal, setForecastClassVerdicts, setForecastReadings, startForecast } from './services/forecastService'
import { listAiCalls } from './services/aiLedgerService'
import { AI_ADDITION_PROMPT_VERSIONS, newsReadingsAt } from '../shared/aiAdditions'
import { onScannerUpdate } from './services/marketScannerService'
import { onNewsFeedUpdate } from './services/newsFeedService'
import { onLiveUpdate } from './services/liveMarketService'
import { stopForecastWorker } from './services/forecastWorkerService'
import { getLiveState, heldBook, readPassBooks, startLiveMarket } from './services/liveMarketService'
import { startExchangeHealth } from './services/exchangeHealthService'
import { startNewsReader } from './services/newsService'
import { startNewsFeed } from './services/newsFeedService'
import { startIncidentVictims } from './services/incidentVictimsService'
import { startAiAdditions } from './services/aiAdditionsService'
import { startLiveUserStream } from './services/liveUserStreamService'
import { startLiveReconcile } from './services/liveReconcileService'
import icon from '../build/icon.png?asset'
import { describeConfigurationAtStart } from './services/effectiveConfigService'
import { sweepAnswerCache } from './services/recordRetentionService'
import { getAiConfig } from './services/aiConfigService'
import { getSettings } from './services/settingsService'
import { closeAction, healKeepRunning, trayTooltip } from '../shared/keepRunning'
import { liveMarketStateOf } from '../shared/liveMarketState'

/** How often the tray's tooltip is read again. */
const TRAY_REFRESH_MS = 30_000

/** True once quitting was asked for -- the tray's Quit, the OS, a second instance ending -- so a
 * close that follows is a close and not a hide (shared/keepRunning.ts). */
let quitting = false
let tray: Tray | null = null
let lastTooltip = ''
/** A check run's label (scripts/shadow-run.mjs sets TRADERSPIDER_TEST_LABEL): its tray icon says so beside the app's
 * own words, as its window's title and banner do, so that a person can tell it from their TraderSpider. Unset, nothing
 * changes. */
const TEST_LABEL = process.env.TRADERSPIDER_TEST_LABEL?.trim() || null

/** The built renderer's page. */
function rendererIndex(): string {
  return join(__dirname, '../renderer/index.html')
}

/** The app's own page, which the window may show and nothing else (V8 Stage 1). */
function ownPage(): OwnPage {
  const devUrl = is.dev && process.env['ELECTRON_RENDERER_URL'] ? process.env['ELECTRON_RENDERER_URL'] : null
  return { devUrl, fileUrl: pathToFileURL(rendererIndex()).href }
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The window plays the notices' sounds (src/sound/; V6 Stage 13) with nobody pressing anything.
      autoplayPolicy: 'no-user-gesture-required',
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer's schedulers (the watch, the exit check, the live-order poll) run at full
      // rate while the window is minimized or hidden (the V5 document, §98-99). Chromium would
      // otherwise hold a hidden page's timers to once a second, and to once a minute after a while.
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // A new window opens nothing (V8 Stage 1): before V8 any window.open went to the system browser, whatever its
  // URL. The guard installed before this window was made holds it to the app's own page (electron/windowGuard.ts).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Closing the window (the V5 document, §98-99; shared/keepRunning.ts): with "Keep running when
  // the window is closed" on (Settings › Essentials), the window hides to the tray and every loop
  // runs on until Quit; off, the app quits as it always did. The setting is read as it stands at
  // that moment, so a change needs no restart. A quit already asked for is never turned into a hide.
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    getSettings()
      .then((settings) => closeAction(healKeepRunning(settings.keepRunningWhenClosed), quitting))
      .catch((): 'quit' => 'quit')
      .then((action) => {
        if (action === 'hide' && !quitting) {
          mainWindow.hide()
          void refreshTray()
        } else {
          quitting = true
          mainWindow.destroy()
        }
      })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(rendererIndex())
  }

  return mainWindow
}

/** The window shown and in front: from the tray, or from a second launch. */
function showWindow(): void {
  const [existing] = BrowserWindow.getAllWindows()
  if (!existing) {
    createWindow()
    return
  }
  if (!existing.isVisible()) existing.show()
  if (existing.isMinimized()) existing.restore()
  existing.focus()
}

/** The tray's tooltip: the socket, the watch, the app's own open paper trades, and what closing
 * the window does. Read from what the services already hold; nothing is asked or changed. */
async function refreshTray(): Promise<void> {
  if (tray === null || tray.isDestroyed()) return
  const [settings, ai] = await Promise.all([getSettings(), getAiConfig()])
  const connection = getLiveState().connection
  const nowMs = Date.now()
  lastTooltip = trayTooltip({
    state: liveMarketStateOf(connection, nowMs),
    ageMs: connection.lastMessageAt === null ? null : nowMs - connection.lastMessageAt,
    watchOn: ai.watch.enabled,
    ownOpen: settings.executors.filter((executor) => executor.watch !== undefined && executor.status === 'active').length,
    keepRunning: healKeepRunning(settings.keepRunningWhenClosed)
  })
  tray.setToolTip(TEST_LABEL === null ? lastTooltip : `${TEST_LABEL} -- ${lastTooltip}`.slice(0, 127))
}

/** The tray icon (the V5 document, §98-99): always there, so a hidden window has a way back, with
 * Open and Quit. Quit is the one way to end the app while "Keep running when the window is
 * closed" is on. */
function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(icon))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open TraderSpider', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit TraderSpider',
        click: (): void => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showWindow)
  void refreshTray().catch(() => undefined)
  setInterval(() => void refreshTray().catch(() => undefined), TRAY_REFRESH_MS)
  // Read by the in-app checks (scripts and scratch profiles only): the tooltip as last set.
  ;(globalThis as { __traderspiderTray?: { tooltip: () => string } }).__traderspiderTray = { tooltip: (): string => lastTooltip }
}

// Only one instance of the app should run at a time. If a second launch is attempted,
// this process (which already holds the lock) is handed the new launch's args instead —
// we just use that as a signal to show and refocus the existing window, then let the second
// process's own app.quit() (below) end it.
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })

  // Asked to quit -- the tray, the OS, app.quit() from anywhere: the windows' close handlers let
  // it through rather than hiding.
  app.on('before-quit', () => {
    quitting = true
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.newtradingbot.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })
    // Every web contents from here on is held to the app's own page (V8 Stage 1; shared/navigationGuard.ts).
    guardEveryWindow(app, ownPage())

    // The research folder (V7.2-R Stage 2): the configuration, the errors and warnings, each paper trade's life
    // and the window's reports, written into <userData>/trader-spider-research/ as the app runs, and packed into
    // a ZIP every day at 00:05 UTC and on a click. Reads no key, asks no model, places nothing. Started first,
    // so that its log holds what the start logs. See researchFolderService.ts.
    startResearchFolder()
    // Binance's and Bitget's public books for the pairs that matter, and Bitget's per-pair fees (V7.2-R Stage 4).
    startVenueQuotes()
    // The record of every prediction that is not the forecast's own, each settled from its venue's bars once its
    // horizon has passed; owed ones read back (V8 Stage 2; predictionLedgerService.ts). Public data only.
    void startPredictionLedger().catch((error) => console.error('The prediction record could not start:', error))
    // The accuracy board (V10 Stage 2; accuracyBoardService.ts): what it kept read back, or the days before read once.
    void startAccuracyBoard().catch((error) => console.error('The accuracy board could not start:', error))
    // V8's three paper books marked once an hour while they run (V8 Stage 2; booksService.ts): nothing while stopped.
    startBookMarks()
    // The primary call weighed every minute and as the announcements are read (V8 Stage 3; primaryCallService.ts): a
    // card only from a measured source and only where its expected net after costs clears its lines. Places nothing.
    startPrimaryCall()
    // Pasted news links' prices read again until final, and discovered news recorded, every five minutes (V8 Stage 4;
    // newsUrlService.ts): public data; a page is fetched only for a link a person pasted, or with its switch on.
    startNewsUrls()
    // The traders a person follows or clones on paper, read as they trade and their clones' rules at each 15-minute
    // close (V8 Stage 8; followService.ts): public data only; the writers that act are the window's, on paper.
    void startFollowing().catch((error) => console.error('Following could not start:', error))
    app.on('will-quit', stopFollowing)
    // The traders the app finds (V9 Stage 3; discoveryService.ts): two public rankings read once a day and up to ten
    // traders a day analysed, half an hour apart, behind every follow's reads. Off with its switch; it places nothing.
    startDiscovery()
    app.on('will-quit', stopDiscovery)
    const mainWindow = createWindow()
    registerIpcHandlers(mainWindow)
    createTray()
    // Watches every real live Position, unattended, for a take-profit/stop-loss/trailing-stop/
    // time-limit exit — main-process-resident rather than driven by a renderer, so it does not
    // depend on which page is open or whether the window has focus. It does NOT outlive the app:
    // closing the window quits on Windows and Linux unless "Keep running when the window is closed"
    // is on (Settings › Essentials, off by default), in which case the window hides to the tray and
    // this loop runs on until Quit; either way any resting order already placed stays live on the
    // exchange. See livePositionWatchersService.ts.
    startLivePositionWatcherLoop()
    // Places the remaining slices of every live TWAP run on their configured interval, same
    // main-process-resident reasoning as the watcher loop above. See liveTwapService.ts.
    startLiveTwapLoop()
    // Reads every watched pair once a minute and says what is moving. Public market data only:
    // no key, no model, no order. It starts here unless it was switched off, and it is
    // main-process-resident for the same reason as the two loops above. See
    // marketScannerService.ts.
    void startMarketScanner().catch((error) => console.error('Market scanner failed to start:', error))
    // Studies the market as the app opens, and every ten minutes after: the liquid pairs, what
    // moved over a day and a week, what is trending, and the market's state. Public data only, and
    // always on, as the second V3 document asks. See marketResearchService.ts.
    startMarketResearch()
    // Keeps ninety days of five-minute bars for the pairs the research reads, and Bitcoin and ether,
    // and extends them as each bar closes: what the price forecast trains on and predicts from (the
    // V6 document, §15 and §40). Public data only: no key, no model, no order. It waits for the
    // research to name its pairs. See forecastDataService.ts.
    startForecastData()
    // Fits the price forecast's models on those bars once enough pairs are there, then scores them on
    // weeks they were not fitted on, and does both again each night at half past midnight UTC unless
    // switched off -- in a worker thread, so the main process is never held up. Public data only: no
    // key, no model of anyone else's, no order. See forecastTrainingService.ts.
    startForecastTraining()
    // Makes the Forecast Lab of each walk forward once it is in use, in the same worker: its record
    // scored, called and replayed as trades (V6 Stage 11). See forecastLabService.ts.
    startForecastLab()
    // Replays the newest walk forward that kept its weeks' models, in the same worker once the training is idle:
    // its weeks after the first forecast again with each week's own models and a calibration from the weeks before,
    // and the paper strategies played on the bars after them (V7.2-R Stage 5). See forecastReplayService.ts.
    startForecastReplay()
    // The decisions are judged by each opportunity class's record: the Lab's replay and the forecast
    // trader's own paper (V6 Stage 12).
    setForecastClassVerdicts(forecastClassVerdict)
    app.on('will-quit', stopForecastWorker)
    // Forecasts every pair at every five-minute close with those models, and again between closes when
    // a story of high impact names it, the scanner raises an event on it, its live price leaves its
    // range or a volume shock hits it; records the forecasts and, when due, what happened. Public
    // data only: no key, no model of anyone else's, no order. See forecastService.ts.
    // Its decisions read a pair's freshest book: the stream's, or one read before the pass for a pair the stream does
    // not carry (V7.2-R Stage 9).
    startForecast(getLiveState, { held: heldBook, read: readPassBooks })
    // The news analyst's readings on file go with the stories, each with when it was answered; reading
    // them costs nothing.
    onNewsFeedUpdate((state) => {
      void (async (): Promise<void> => {
        const sinceSec = Math.floor(Date.now() / 1000) - 8 * 86_400
        const page = await listAiCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, sinceSec, limit: 1000 }).catch(() => null)
        if (page !== null) setForecastReadings(newsReadingsAt(page.rows))
        await forecastNewsSignal(state)
      })().catch((error) => console.error('A forecast news signal failed:', error))
    })
    onScannerUpdate((state) => void forecastScannerSignal(state).catch((error) => console.error('A forecast scanner signal failed:', error)))
    // The scanner's movers over the liquidity floor join the forecast's pairs (V7.2-R Stage 4).
    onScannerUpdate((state) => setForecastMovers(scannerMovers(state.pairs)))
    let liveCheckedAt = 0
    onLiveUpdate((state) => {
      // Four pushes a second: the stream is looked at for the forecast every five seconds.
      if (Date.now() - liveCheckedAt < 5000) return
      liveCheckedAt = Date.now()
      void forecastLiveSignal(state).catch((error) => console.error('A forecast live signal failed:', error))
    })
    // Holds one public socket to the market-data host: the best bid and ask and the minute forming
    // for the pairs shown and the app's own paper trades, and Bitcoin's and ether's minutes always.
    // No key, no model, no order. See liveMarketService.ts.
    startLiveMarket()
    // Measures the data host once a minute -- one public request for the time -- and keeps the
    // stream's state and the key's last test beside it. The live order gate reads its verdict before
    // a real position is opened; a closing order never. No key, no model, no order. See
    // exchangeHealthService.ts.
    startExchangeHealth()
    // Reads Binance's announcement lists once a minute and keeps each article once. One public
    // list, no key, no model, no order; started here only if it was left switched on. See
    // newsService.ts.
    void startNewsReader().catch((error) => console.error('News reader failed to start:', error))
    // Reads four free media feeds every minute, sets Binance's announcements beside them, and
    // measures what the price did around each story. Public data; no key, model or order. See
    // newsFeedService.ts.
    void startNewsFeed().catch((error) => console.error('News feed failed to start:', error))
    // The table a hack's victim is named by, read again from DefiLlama's two public lists once it is
    // a week old. See incidentVictimsService.ts.
    void startIncidentVictims().catch((error) => console.error('The hack victims table failed to start:', error))
    // The AI additions that ask by themselves (shared/aiAdditions.ts): the news analyst, on each
    // story of high impact the feed reads -- only while the watch is on, within its own daily limit
    // and the budget. It places nothing. See aiAdditionsService.ts.
    startAiAdditions()
    // The account's own stream (the V5 document, S101): while a Binance key is stored and the
    // session is armed or an order or position of the app's own is open, one authenticated socket
    // hears each order's fate and the balances after it, and books a fill at once through the
    // function the 5-second poll uses. It places, cancels and sizes nothing. See
    // liveUserStreamService.ts.
    startLiveUserStream()
    // The reconciliation (S102): once a minute while a key is stored, the orders resting on the
    // exchange and the account's balances against the ledgers; what disagrees is told as a notice
    // and shown on Live Trading and Positions, and the ledger is never rewritten by it. See
    // liveReconcileService.ts.
    startLiveReconcile()
    // Says, once every store has read its file, what the start read: each settings file's version
    // and what was migrated, and every value the heal changed (the V5 document, §107). It reads
    // what the services already hold and changes nothing. See effectiveConfigService.ts.
    // First the answer cache is swept of files older than the retention (shared/retention.ts; the
    // V5 document, §93) -- cached answers alone, never a monthly file -- so that the line says what
    // the records weigh after it. See recordRetentionService.ts.
    void sweepAnswerCache()
      .catch((error) => {
        console.error('The answer cache could not be swept:', error)
        return 0
      })
      .then(() => describeConfigurationAtStart())
      .then((line) => console.log(line))
      .catch((error) => console.error('The configuration could not be described:', error))

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
