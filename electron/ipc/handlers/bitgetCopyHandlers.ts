import { ipcMain } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type { BitgetCopyCheck } from '../../../shared/traders/traderAnalysis'
import { bitgetCopyCheck } from '../../services/exchanges/bitgetCopyRead'

// THE BITGET COPY-TRADING CHECK (V8 Stage 6; the user's answer of 26 October 2026: on a click, read-only). One
// channel, asked only from its button on Copy Traders: the account's mode, whether the key may read copy trading, and
// the traders it copies, each a GET with the key typed on Connections (exchanges/bitgetCopyRead.ts). The key never
// crosses the bridge, and nothing is subscribed, changed or placed.

export function registerBitgetCopyHandlers(): void {
  ipcMain.handle(IpcChannel.TradersBitgetCheck, (): Promise<BitgetCopyCheck> => bitgetCopyCheck())
}
