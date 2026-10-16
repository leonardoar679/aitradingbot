import { ipcMain } from 'electron'
import { IpcChannel, type CredentialSetOptions, type CredentialSlot, type Exchange } from '../../../shared/ipc'
import {
  listCredentialStatus,
  setCredential,
  testCredential,
  removeCredential,
  closeFuturesPositionFor,
  readFuturesPositions,
  readFuturesStops,
  placeFuturesStopFor,
  cancelFuturesStopFor,
  readLiveBalances
} from '../../services/credentialsService'

export function registerCredentialsHandlers(): void {
  ipcMain.handle(IpcChannel.CredentialsList, () => listCredentialStatus())
  ipcMain.handle(IpcChannel.CredentialsSet, (_event, exchange: Exchange, apiKey: string, apiSecret: string, options?: CredentialSetOptions) =>
    setCredential(exchange, apiKey, apiSecret, options ?? {})
  )
  ipcMain.handle(IpcChannel.CredentialsTest, (_event, exchange: Exchange, slot?: CredentialSlot) => testCredential(exchange, slot ?? 'real'))
  ipcMain.handle(IpcChannel.CredentialsRemove, (_event, exchange: Exchange, slot?: CredentialSlot) => removeCredential(exchange, slot ?? 'real'))
  ipcMain.handle(IpcChannel.CredentialsFuturesPositions, (_event, exchange: Exchange) => readFuturesPositions(exchange))
  ipcMain.handle(IpcChannel.CredentialsCloseFuturesPosition, (_event, exchange: Exchange, symbol: string) =>
    closeFuturesPositionFor(exchange, symbol)
  )
  ipcMain.handle(IpcChannel.CredentialsFuturesStops, (_event, exchange: Exchange) => readFuturesStops(exchange))
  ipcMain.handle(IpcChannel.CredentialsPlaceFuturesStop, (_event, exchange: Exchange, symbol: string, stopPrice: number) =>
    placeFuturesStopFor(exchange, symbol, stopPrice)
  )
  ipcMain.handle(IpcChannel.CredentialsCancelFuturesStop, (_event, exchange: Exchange, symbol: string, orderId: number) =>
    cancelFuturesStopFor(exchange, symbol, orderId)
  )
  ipcMain.handle(IpcChannel.CredentialsBalances, (_event, exchange: Exchange, force: boolean, slot?: CredentialSlot) =>
    readLiveBalances(exchange, force, slot ?? 'real')
  )
}
