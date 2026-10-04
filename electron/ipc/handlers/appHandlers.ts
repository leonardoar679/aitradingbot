import { ipcMain, app, BrowserWindow, Notification } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { pingService } from '../../services/pingService'

/** Notifications on screen. Held because one that has been garbage-collected cannot be clicked. */
const shown = new Set<Notification>()

export function registerAppHandlers(): void {
  ipcMain.handle(IpcChannel.AppPing, () => pingService())
  ipcMain.handle(IpcChannel.AppGetVersion, () => app.getVersion())

  // A desktop notice, raised from the main process so that clicking it can bring the window back:
  // the renderer's own Notification can ask for focus and is not always given it. It shows text
  // and focuses the window. It carries nothing to act on and does nothing else when clicked.
  ipcMain.handle(IpcChannel.AppNotify, (event, title: unknown, body: unknown): boolean => {
    if (typeof title !== 'string' || typeof body !== 'string' || !Notification.isSupported()) return false
    const notification = new Notification({ title: title.slice(0, 120), body: body.slice(0, 400) })
    shown.add(notification)
    const forget = (): void => void shown.delete(notification)
    notification.on('close', forget)
    notification.on('failed', forget)
    notification.on('click', () => {
      forget()
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
    notification.show()
    return true
  })
}
