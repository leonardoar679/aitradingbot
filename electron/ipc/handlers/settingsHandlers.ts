import { ipcMain } from 'electron'
import { IpcChannel, type AppSettings } from '../../../shared/ipc'
import { healPaperBooks } from '../../../shared/paperBooks'
import { getSettings, setSettings } from '../../services/settingsService'

/** A window's patch of the settings, or why it is refused: the paper books are started and stopped by Start and Stop
 * paper testing alone (V8 Stage 9), which write what they turned on first, so a patch may carry them only unchanged. */
export async function windowSettingsPatch(patch: Partial<AppSettings>): Promise<Partial<AppSettings>> {
  if (typeof patch !== 'object' || patch === null || !('paperBooks' in patch)) return patch
  const { paperBooks, ...rest } = patch
  if (JSON.stringify(healPaperBooks(paperBooks)) !== JSON.stringify(healPaperBooks((await getSettings()).paperBooks))) {
    throw new Error('The paper books are started and stopped by Start and Stop paper testing on Paper Trading, not by a setting.')
  }
  return rest
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IpcChannel.SettingsGet, () => getSettings())
  ipcMain.handle(IpcChannel.SettingsSet, async (_event, patch: Partial<AppSettings>) => setSettings(await windowSettingsPatch(patch)))
}
