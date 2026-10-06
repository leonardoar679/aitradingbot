import { ipcMain, app, BrowserWindow, Notification } from 'electron'
import { healAlerts } from '../../../shared/alerts'
import { IpcChannel } from '../../../shared/ipc'
import { pingService } from '../../services/pingService'
import { getSettings } from '../../services/settingsService'

/** Notifications on screen. Held because one that has been garbage-collected cannot be clicked. */
const shown = new Set<Notification>()

export function registerAppHandlers(): void {
  ipcMain.handle(IpcChannel.AppPing, () => pingService())
  ipcMain.handle(IpcChannel.AppGetVersion, () => app.getVersion())

  // A desktop notice, raised from the main process so that clicking it can bring the window back:
  // the renderer's own Notification can ask for focus and is not always given it. It shows text
  // and focuses the window. It carries nothing to act on and does nothing else when clicked.
  //
  // Every notice the app raises comes through here, so this is where the "Notifications" control
  // is obeyed (shared/alerts.ts): switched off, nothing is shown; without sound, it is shown
  // silently. False, as for a desktop that cannot show one, when nothing was shown.
  ipcMain.handle(IpcChannel.AppNotify, async (event, title: unknown, body: unknown): Promise<boolean> => {
    if (typeof title !== 'string' || typeof body !== 'string' || !Notification.isSupported()) return false
    const alerts = healAlerts((await getSettings()).alerts)
    if (!alerts.enabled) return false
    const notification = new Notification({ title: title.slice(0, 120), body: body.slice(0, 400), silent: !alerts.sound })
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
