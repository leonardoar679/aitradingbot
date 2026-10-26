import { allowedNavigation, type OwnPage } from '../shared/navigationGuard'

// Every window and web contents the app makes is held to its own page (shared/navigationGuard.ts; V8 Stage 1):
// a new window is denied and opens nothing -- before V8 a window.open of any URL went to the system browser --
// a navigation or a redirect anywhere but the app's own page is stopped, and a <webview> is never attached.

/** What a web contents offers the guard: the shapes of Electron's own, so a test can hand in a fake. */
export interface GuardedContents {
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): unknown
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): unknown
}

/** Holds one web contents to the app's own page. */
export function guardWebContents(contents: GuardedContents, own: OwnPage): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const stop = (event: { preventDefault(): void }, url: string): void => {
    if (!allowedNavigation(url, own)) {
      event.preventDefault()
      console.warn(`The window was kept from going to ${url.slice(0, 200)}: it shows the app's own page only.`)
    }
  }
  contents.on('will-navigate', stop)
  contents.on('will-redirect', stop)
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

/** Holds every web contents made from now on: called once, before the first window. */
export function guardEveryWindow(app: { on(event: 'web-contents-created', listener: (event: unknown, contents: GuardedContents) => void): unknown }, own: OwnPage): void {
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents, own))
}
