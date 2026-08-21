/** electron's ipcRenderer.invoke wraps a thrown main-process error as
 * "Error invoking remote method '<channel>': Error: <message>". Left in place the user is shown
 * an IPC channel name instead of the reason — "Error invoking remote method
 * 'market:subscribeCandles': Error: fetch failed" rather than "fetch failed".
 *
 * Lived privately in SettingsPanel.tsx, which meant every other surface that shows an error from
 * an IPC call displayed the raw wrapper. */
export function cleanIpcErrorMessage(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

/** The same, for an unknown caught value. */
export function describeError(error: unknown): string {
  return cleanIpcErrorMessage(error instanceof Error ? error.message : String(error))
}
