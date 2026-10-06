import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { startLivePositionWatcherLoop } from './services/livePositionWatchersService'
import { startLiveTwapLoop } from './services/liveTwapService'
import { startMarketScanner } from './services/marketScannerService'
import { startMarketResearch } from './services/marketResearchService'
import { startNewsReader } from './services/newsService'
import icon from '../build/icon.png?asset'

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// Only one instance of the app should run at a time. If a second launch is attempted,
// this process (which already holds the lock) is handed the new launch's args instead —
// we just use that as a signal to refocus the existing window, then let the second
// process's own app.quit() (below) end it.
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existingWindow] = BrowserWindow.getAllWindows()
    if (existingWindow) {
      if (existingWindow.isMinimized()) existingWindow.restore()
      existingWindow.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.newtradingbot.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const mainWindow = createWindow()
    registerIpcHandlers(mainWindow)
    // Watches every real live Position, unattended, for a take-profit/stop-loss/trailing-stop/
    // time-limit exit — main-process-resident rather than driven by a renderer, so it does not
    // depend on which page is open or whether the window has focus. It does NOT outlive the app:
    // window-all-closed quits on Windows and Linux, which ends this loop while any resting order
    // already placed stays live on the exchange. See livePositionWatchersService.ts.
    startLivePositionWatcherLoop()
    // Places the remaining slices of every live TWAP run on their configured interval, same
    // main-process-resident reasoning as the watcher loop above. See liveTwapService.ts.
    startLiveTwapLoop()
    // Reads every watched pair once a minute and says what is moving. Public market data only:
    // no key, no model, no order. It starts here only if it was left switched on, and it is
    // main-process-resident for the same reason as the two loops above. See
    // marketScannerService.ts.
    void startMarketScanner().catch((error) => console.error('Market scanner failed to start:', error))
    // Studies the market as the app opens, and every ten minutes after: the liquid pairs, what
    // moved over a day and a week, what is trending, and the market's state. Public data only, and
    // always on, as the second V3 document asks. See marketResearchService.ts.
    startMarketResearch()
    // Reads Binance's announcement lists once a minute and keeps each article once. One public
    // list, no key, no model, no order; started here only if it was left switched on. See
    // newsService.ts.
    void startNewsReader().catch((error) => console.error('News reader failed to start:', error))

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
