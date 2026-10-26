import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowedNavigation } from '../shared/navigationGuard'
import { guardEveryWindow, guardWebContents, type GuardedContents } from '../electron/windowGuard'

// THE WINDOW IS HELD TO ITS OWN PAGE (V8 Stage 1): before V8 brings pasted URLs, article text and traders' names
// on screen, the window may show the app's own page only, opens no new window, attaches no <webview>, and the
// renderer holds no link of any kind -- an external page opens through the main process, by a record's id.

const ROOT = join(__dirname, '..')
const DEV = { devUrl: 'http://localhost:5173', fileUrl: null }
const BUILT = { devUrl: null, fileUrl: 'file:///C:/Program%20Files/TraderSpider/resources/app.asar/out/renderer/index.html' }

describe('where the window may go', () => {
  it("goes to the dev server's own origin, and nowhere else", () => {
    expect(allowedNavigation('http://localhost:5173/', DEV)).toBe(true)
    expect(allowedNavigation('http://localhost:5173/#/predictions', DEV)).toBe(true)
    expect(allowedNavigation('http://localhost:5174/', DEV)).toBe(false)
    expect(allowedNavigation('https://localhost:5173/', DEV)).toBe(false)
    expect(allowedNavigation('https://example.com/', DEV)).toBe(false)
    expect(allowedNavigation('file:///C:/Windows/win.ini', DEV)).toBe(false)
  })

  it("goes to the built renderer's own file, its hash or query changed, and nothing else", () => {
    expect(allowedNavigation(BUILT.fileUrl, BUILT)).toBe(true)
    expect(allowedNavigation(`${BUILT.fileUrl}#home`, BUILT)).toBe(true)
    expect(allowedNavigation(BUILT.fileUrl.replace('C:', 'c:'), BUILT)).toBe(true)
    expect(allowedNavigation('file:///C:/Windows/win.ini', BUILT)).toBe(false)
    expect(allowedNavigation('file:///C:/Program%20Files/TraderSpider/resources/app.asar/out/renderer/other.html', BUILT)).toBe(false)
    expect(allowedNavigation('https://www.binance.com/en/support/announcement', BUILT)).toBe(false)
  })

  it('refuses what is not a web address at all', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'about:blank', 'chrome://settings', 'not a url', '']) {
      expect(allowedNavigation(url, DEV), url).toBe(false)
      expect(allowedNavigation(url, BUILT), url).toBe(false)
    }
    // A dev URL that is not an http(s) address allows nothing by itself.
    expect(allowedNavigation('file:///x', { devUrl: 'file:///x', fileUrl: null })).toBe(false)
  })
})

/** A web contents' guard hooks, recorded. */
function fakeContents(): GuardedContents & { open: (() => { action: string }) | null; listeners: Map<string, (event: { preventDefault(): void }, url?: string) => void> } {
  const listeners = new Map<string, (event: { preventDefault(): void }, url?: string) => void>()
  const contents = {
    open: null as (() => { action: string }) | null,
    listeners,
    setWindowOpenHandler(handler: () => { action: 'deny' }) {
      contents.open = handler
    },
    on(event: string, listener: (event: { preventDefault(): void }, url?: string) => void) {
      listeners.set(event, listener)
      return contents
    }
  }
  return contents as never
}

/** Fires an event and says whether it was stopped. */
function fired(contents: ReturnType<typeof fakeContents>, event: string, url?: string): boolean {
  let stopped = false
  contents.listeners.get(event)!({ preventDefault: () => void (stopped = true) }, url)
  return stopped
}

describe('the guard on a web contents', () => {
  it('denies every new window, stops a navigation or a redirect off its own page, and never attaches a webview', () => {
    const contents = fakeContents()
    guardWebContents(contents, BUILT)
    expect(contents.open!()).toEqual({ action: 'deny' })
    expect(fired(contents, 'will-navigate', 'https://example.com/')).toBe(true)
    expect(fired(contents, 'will-redirect', 'https://example.com/')).toBe(true)
    expect(fired(contents, 'will-navigate', BUILT.fileUrl)).toBe(false)
    expect(fired(contents, 'will-redirect', `${BUILT.fileUrl}#x`)).toBe(false)
    expect(fired(contents, 'will-attach-webview')).toBe(true)
  })

  it('is put on every web contents the app makes', () => {
    let created: ((event: unknown, contents: GuardedContents) => void) | null = null
    guardEveryWindow({ on: (_event, listener) => void (created = listener) }, DEV)
    const contents = fakeContents()
    created!({}, contents)
    expect(contents.open!()).toEqual({ action: 'deny' })
    expect(fired(contents, 'will-navigate', 'https://example.com/')).toBe(true)
  })
})

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(path)
  }
  return out
}

describe('the main process and the renderer, as written', () => {
  it('installs the guard before the first window, and opens nothing from a new window', () => {
    const main = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf-8')
    expect(main).toMatch(/guardEveryWindow\(app, ownPage\(\)\)/)
    expect(main.indexOf('guardEveryWindow(app')).toBeLessThan(main.indexOf('const mainWindow = createWindow()'))
    expect(main).toMatch(/setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
    expect(main).not.toMatch(/shell\.openExternal/)
  })

  it("gives the window the app's own bridges alone, never the generic ipcRenderer", () => {
    const preload = readFileSync(join(ROOT, 'electron', 'preload.ts'), 'utf-8')
    expect([...preload.matchAll(/exposeInMainWorld\(\s*'(\w+)'/g)].map((match) => match[1])).toEqual(['api'])
    expect(preload).not.toMatch(/@electron-toolkit\/preload/)
  })

  it('holds no link, no window.open and no raw HTML anywhere in the renderer', () => {
    const offences: string[] = []
    for (const file of filesUnder(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf-8')
      for (const pattern of [/\bhref\s*=/, /target\s*=\s*["']_blank["']/, /window\.open\s*\(/, /dangerouslySetInnerHTML/, /\bsrcDoc\b/]) {
        if (pattern.test(text)) offences.push(`${file.slice(ROOT.length + 1)}: ${pattern}`)
      }
    }
    expect(offences).toEqual([])
  })
})
