import { ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { getNewsFeedState, onNewsFeedUpdate, openStoryLink } from '../../services/newsFeedService'

// The news feed (the second V3 document, §11-14). Nothing here can spend money or place an order:
// the stories are public feeds and Binance's announcements, these channels show them, and a story's
// link opens in the browser only on https and on the feeds' own hosts.
export function registerNewsFeedHandlers(mainWindow: BrowserWindow): void {
  const stopForwarding = onNewsFeedUpdate((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IpcChannel.FeedUpdate, state)
  })
  mainWindow.on('closed', stopForwarding)

  ipcMain.handle(IpcChannel.FeedGetState, () => getNewsFeedState())
  ipcMain.handle(IpcChannel.FeedOpenLink, (_event, url: unknown) => openStoryLink(url))
}
