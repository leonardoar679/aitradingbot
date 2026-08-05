import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IpcChannel, type AppSettings, type PriceUpdate } from '../shared/ipc'

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke(IpcChannel.AppPing),
  getVersion: (): Promise<string> => ipcRenderer.invoke(IpcChannel.AppGetVersion),
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IpcChannel.SettingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IpcChannel.SettingsSet, patch)
  },
  market: {
    subscribe: (symbol: string): Promise<void> => ipcRenderer.invoke(IpcChannel.MarketSubscribe, symbol),
    unsubscribe: (symbol: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.MarketUnsubscribe, symbol),
    onPriceUpdate: (listener: (update: PriceUpdate) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, update: PriceUpdate): void => listener(update)
      ipcRenderer.on(IpcChannel.MarketPriceUpdate, handler)
      return () => ipcRenderer.removeListener(IpcChannel.MarketPriceUpdate, handler)
    }
  }
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error(error)
}

export type Api = typeof api
