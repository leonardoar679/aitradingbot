// Shared by the app drivers in scripts/: where the checkout and its Electron binary are, how two
// paths are compared on this platform, and how app processes left by a previous run are cleared.
// drive-app.mjs (a REPL) and shadow-run.mjs (an unattended run) both launch the app through
// playwright-core, which is deliberately NOT a dependency of the app:
//
//   npm install --no-save playwright-core

import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const ELECTRON_BIN =
  process.platform === 'win32'
    ? path.join(APP_DIR, 'node_modules/electron/dist/electron.exe')
    : process.platform === 'darwin'
      ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
      : path.join(APP_DIR, 'node_modules/electron/dist/electron')

export const samePath = (a, b) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)

/** Kills app processes left running by a previous run of a driver, matched by `needle`: the path
 * every process of that instance carries on its command line and no other does -- a scratch
 * profile's folder, or the repo path for an app started from this checkout.
 *
 * The app is not leaking: main.ts handles `window-all-closed` with app.quit(), and killing the
 * main process tears its children down cleanly -- both were checked. What strands processes is
 * A DRIVER dying before quit() runs: a `timeout` expiring around a slow command, a Ctrl-C, a
 * crash. Playwright's electronApp.close() is the only thing that stops the app it launched, so if
 * the driver never reaches it, all four processes stay up. Measured: SIGKILL the driver after
 * launch and four remain.
 *
 * That matters because they hold the app's single-instance lock, so the NEXT launch exits
 * immediately with code 0 and no error, and Playwright reports a bare "Process failed to launch!"
 * naming no cause. The failure reads like a broken build, and it cost two debugging sessions
 * before it was understood.
 *
 * Matching on a path is not optional. Claude Code and VS Code are themselves Electron apps, and a
 * blanket `Stop-Process -Name electron` kills the editor this is running inside. The repo path
 * alone also matches an app the user started themselves from this checkout, which is why a driver
 * on a scratch profile matches on that profile's path instead.
 *
 * Windows-only, since that is where this was measured; a no-op elsewhere. */
export function reapStaleApps(needle) {
  if (process.platform !== 'win32') return Promise.resolve(0)
  // -Force so a hung process still goes; SilentlyContinue so a process that exits between the
  // query and the kill is not an error.
  // .Contains() rather than -like: -like treats [ ] * ? as wildcards, and a path is a literal.
  // Single-quoted PowerShell strings take backslashes literally, so the path needs no escaping
  // beyond doubling any apostrophe in it.
  const literal = String(needle).replace(/'/g, "''")
  const script = `
    $procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') }
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    ($procs | Measure-Object).Count`
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15_000 },
      (err, stdout) => resolve(err ? 0 : Number(String(stdout).trim()) || 0)
    )
  })
}
