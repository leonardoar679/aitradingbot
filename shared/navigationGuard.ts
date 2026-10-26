// WHERE THE WINDOW MAY GO (V8 Stage 1, 26 October 2026).
//
// Until V8 the renderer showed no link and no text it had not written itself: every story's link opened
// through the main process on a feed's own host. V8 puts pasted URLs, article text and traders' names on
// screen, chosen by whoever wrote them, so the window is held to its own page before any of that arrives:
// it may load the app's own renderer and nothing else, opens no new window, and attaches no <webview>.
// A link the app means to open goes to the system browser through the main process, by a record's id,
// checked again there (electron/windowGuard.ts).

/** The app's own page: the dev server's origin while developing, the renderer's index file when built. */
export interface OwnPage {
  /** The dev server's URL (ELECTRON_RENDERER_URL), or null in a built app. */
  devUrl: string | null
  /** The renderer's index.html as a file: URL, in a built app. */
  fileUrl: string | null
}

/** Whether the window may navigate to `url`: only to the app's own page, never anywhere else. */
export function allowedNavigation(url: string, own: OwnPage): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (own.devUrl !== null) {
    try {
      const dev = new URL(own.devUrl)
      if ((dev.protocol === 'http:' || dev.protocol === 'https:') && target.origin === dev.origin) return true
    } catch {
      // A dev URL that is not one allows nothing by itself.
    }
  }
  if (own.fileUrl !== null && target.protocol === 'file:') {
    try {
      const file = new URL(own.fileUrl)
      // The same file, whatever its hash or query: the page reloading itself.
      return file.protocol === 'file:' && decodeURIComponent(target.pathname).toLowerCase() === decodeURIComponent(file.pathname).toLowerCase()
    } catch {
      return false
    }
  }
  return false
}
