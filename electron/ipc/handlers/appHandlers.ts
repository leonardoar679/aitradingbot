import { ipcMain, app } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { healNoticeRequest, tellNotice } from '../../services/noticeService'
import { pingService } from '../../services/pingService'

export function registerAppHandlers(): void {
  ipcMain.handle(IpcChannel.AppPing, () => pingService())
  ipcMain.handle(IpcChannel.AppGetVersion, () => app.getVersion())

  // A desktop notice, raised from the main process so that clicking it can bring the window back:
  // the renderer's own Notification can ask for focus and is not always given it. Every notice the
  // app raises comes through here or through the main process's own loops, and one service tells
  // them all (electron/services/noticeService.ts): it keeps one thread per kind and pair, obeys the
  // Notifications control, records what it told, and tells the window. False, as for a desktop that
  // cannot show one, when nothing was shown.
  ipcMain.handle(IpcChannel.AppNotify, (event, title: unknown, body: unknown, severity?: unknown, extra?: unknown): Promise<boolean> =>
    tellNotice(healNoticeRequest(title, body, severity, extra), event.sender)
  )
}
