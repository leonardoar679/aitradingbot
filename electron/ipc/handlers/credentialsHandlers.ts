import { ipcMain } from 'electron'
import { IpcChannel, type Exchange } from '../../../shared/ipc'
import {
  listCredentialStatus,
  setCredential,
  testCredential,
  removeCredential,
  closeFuturesPositionFor,
  readFuturesPositions,
  readLiveBalances
} from '../../services/credentialsService'

export function registerCredentialsHandlers(): void {
  ipcMain.handle(IpcChannel.CredentialsList, () => listCredentialStatus())
  ipcMain.handle(IpcChannel.CredentialsSet, (_event, exchange: Exchange, apiKey: string, apiSecret: string) =>
    setCredential(exchange, apiKey, apiSecret)
  )
  ipcMain.handle(IpcChannel.CredentialsTest, (_event, exchange: Exchange) => testCredential(exchange))
  ipcMain.handle(IpcChannel.CredentialsRemove, (_event, exchange: Exchange) => removeCredential(exchange))
  ipcMain.handle(IpcChannel.CredentialsFuturesPositions, (_event, exchange: Exchange) => readFuturesPositions(exchange))
  ipcMain.handle(IpcChannel.CredentialsCloseFuturesPosition, (_event, exchange: Exchange, symbol: string) =>
    closeFuturesPositionFor(exchange, symbol)
  )
  ipcMain.handle(IpcChannel.CredentialsBalances, (_event, exchange: Exchange, force: boolean) =>
    readLiveBalances(exchange, force)
  )
}
