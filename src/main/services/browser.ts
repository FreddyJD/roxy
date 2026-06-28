/**
 * The Roxy browser — a real, persistent Electron BrowserWindow the agent can
 * drive. It uses a `persist:` session partition so cookies/logins survive
 * restarts (sign in once, automate forever), and it taps Electron's native
 * APIs to screenshot the page, read its HTML, and collect console messages.
 *
 * This is the foundation for full browser automation: every capability here is
 * exposed to the agent as a `browser_*` tool (see ../harness/tools.ts).
 */
import { BrowserView, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CHANNELS } from '../../shared/ipc'
import type { BrowserState, BrowserTab } from '../../shared/api'

/** Persisted session → cookies, localStorage and logins survive app restarts. */
const PARTITION = 'persist:roxy-browser'
const MAX_CONSOLE = 500
/** Height of the chrome overlaid at the top: tab strip + URL-bar toolbar. */
const CHROME_H = 80
/** Where a blank/new tab lands — a homepage, like a normal browser. */
const HOME_URL = 'https://www.google.com'

/** App icon path, injected from main (so this file has no `?asset` import — the
 *  smoke harness bundles it with esbuild, which doesn't understand `?asset`). */
let appIconPath: string | undefined
export function setAppIcon(p: string): void {
  appIconPath = p
}

export interface ConsoleEntry {
  /** 0=verbose, 1=info, 2=warning, 3=error (Electron's console level). */
  level: number
  message: string
  line?: number
  url?: string
  ts: number
}

let win: BrowserWindow | null = null
/** One open tab — a persistent-session page view. The active tab fills the
 *  window; the rest sit at zero size (still alive, so their pages are kept). */
interface Tab {
  id: string
  view: BrowserView
}
let tabs: Tab[] = []
let activeTabId: string | null = null
let consoleLog: ConsoleEntry[] = []
let tabSeq = 0

/** The active tab's view, or null when there's no usable tab. */
function activeView(): BrowserView | null {
  const t = tabs.find((x) => x.id === activeTabId)
  return t && !t.view.webContents.isDestroyed() ? t.view : null
}

/** The active page's contents — what every browser_* tool drives. */
function pageContents(): Electron.WebContents {
  const v = activeView()
  if (!v) throw new Error('No browser is open. Use browser_open first.')
  return v.webContents
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (!activeView()) createTab()
    return win
  }
  consoleLog = []
  tabs = []
  activeTabId = null
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    title: 'Roxy Browser',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    ...(isMac || !appIconPath ? {} : { icon: appIconPath }),
    // Hide the native OS title bar — our React chrome (tab strip + URL bar) IS
    // the title bar. Keep native window controls, themed to match (no second
    // light bar stacked on top of the chrome).
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 12, y: 14 } }
      : { titleBarOverlay: { color: '#0f0f10', symbolColor: '#9a9aa3', height: 40 } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // The chrome (tab strip + URL bar) is a real React app rendered into the
  // WINDOW's OWN webContents — not a BrowserView — so its title-bar strip is
  // draggable via `-webkit-app-region` (which doesn't work inside a BrowserView)
  // and the native control overlay lands on it cleanly. Page tabs sit in
  // BrowserViews on top, below the chrome. Best-effort load (the test harness
  // has no bundled browser.html — the pages still work).
  win.webContents.once('did-finish-load', () => {
    pushState()
    pushTabs()
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/browser.html`).catch(() => undefined)
  } else {
    void win.webContents.loadFile(path.join(__dirname, '../renderer/browser.html')).catch(() => undefined)
  }

  win.on('resize', layout)
  win.on('closed', () => {
    win = null
    tabs = []
    activeTabId = null
  })

  createTab()
  return win
}

/** Lay out the chrome strip + active page; park inactive tabs at zero size. */
function layout(): void {
  if (!win || win.isDestroyed()) return
  const { width, height } = win.getContentBounds()
  for (const t of tabs) {
    if (t.view.webContents.isDestroyed()) continue
    t.view.setBounds(
      t.id === activeTabId
        ? { x: 0, y: CHROME_H, width, height: Math.max(0, height - CHROME_H) }
        : { x: 0, y: 0, width: 0, height: 0 }
    )
  }
}

/** Create a tab (optionally at a URL) and make it active. Assumes a window. */
function createTab(rawUrl?: string): string {
  if (!win || win.isDestroyed()) return ''
  const view = new BrowserView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const id = `tab-${++tabSeq}`
  const tab: Tab = { id, view }
  tabs.push(tab)
  win.addBrowserView(view)
  wireTab(tab)
  activeTabId = id
  layout()
  pushTabs()
  void view.webContents
    .loadURL(rawUrl ? normalizeUrl(rawUrl) : HOME_URL)
    .catch(() => undefined)
  return id
}

/** Console + navigation listeners for a tab's page. */
function wireTab(tab: Tab): void {
  const wc = tab.view.webContents
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    consoleLog.push({ level, message, line, url: sourceId, ts: Date.now() })
    if (consoleLog.length > MAX_CONSOLE) consoleLog = consoleLog.slice(-MAX_CONSOLE)
  })
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3 /* not a benign ERR_ABORTED */) {
      consoleLog.push({
        level: 3,
        message: `Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`,
        ts: Date.now()
      })
    }
  })
  const onNav = (): void => {
    if (tab.id === activeTabId) pushState()
    pushTabs()
  }
  wc.on('did-navigate', onNav)
  wc.on('did-navigate-in-page', onNav)
  wc.on('did-start-loading', onNav)
  wc.on('did-stop-loading', onNav)
  wc.on('page-title-updated', onNav)
}

/** Send the active tab's navigation state to the toolbar. */
function pushState(): void {
  const v = activeView()
  if (!v || !win || win.isDestroyed() || win.webContents.isDestroyed()) return
  const wc = v.webContents
  const state: BrowserState = {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoadingMainFrame()
  }
  win.webContents.send(CHANNELS.browserState, state)
}

/** The open tabs (id, title, url, active) — also used by the browser_tabs tool. */
export function listTabs(): BrowserTab[] {
  return tabs.map((t) => {
    const dead = t.view.webContents.isDestroyed()
    return {
      id: t.id,
      title: dead ? '' : t.view.webContents.getTitle() || 'New tab',
      url: dead ? '' : t.view.webContents.getURL(),
      active: t.id === activeTabId
    }
  })
}

/** Send the open tab list to the toolbar's tab strip. */
function pushTabs(): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(CHANNELS.browserTabs, listTabs())
}

/** Add a scheme when the user/agent passes a bare host like "github.com". */
function normalizeUrl(input: string): string {
  const url = input.trim()
  if (!url) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith('about:')) return url
  return `https://${url}`
}

export async function open(rawUrl: string): Promise<{ url: string; title: string; error?: string }> {
  ensureWindow()
  const wc = pageContents()
  const url = normalizeUrl(rawUrl)
  // Show the window so you can watch the agent browse, but DON'T steal focus
  // (showInactive) — the agent driving the browser shouldn't yank you out of
  // whatever you're typing. The Settings "Open browser" button (openWindow)
  // still focuses it for manual sign-in.
  if (win?.isMinimized()) win.restore()
  win?.showInactive()
  let error: string | undefined
  try {
    await wc.loadURL(url)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  return { url: wc.getURL() || url, title: wc.getTitle(), error }
}

export async function screenshot(
  saveDir?: string
): Promise<{ dataUrl: string; width: number; height: number; savedTo?: string }> {
  const wc = pageContents()
  if (win?.isMinimized()) win.restore()
  let image = await wc.capturePage()
  const { width: rawWidth } = image.getSize()
  // Downscale large captures so the inline preview stays light.
  if (rawWidth > 1280) image = image.resize({ width: 1280 })
  const { width, height } = image.getSize()
  const dataUrl = `data:image/jpeg;base64,${image.toJPEG(72).toString('base64')}`

  let savedTo: string | undefined
  if (saveDir) {
    const dir = path.join(saveDir, '.roxy', 'screenshots')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `shot-${Date.now()}.png`)
    await fs.writeFile(file, image.toPNG())
    savedTo = path.relative(saveDir, file)
  }
  return { dataUrl, width, height, savedTo }
}

export async function getHtml(selector?: string): Promise<string> {
  const code = selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
      ` return el ? el.outerHTML : ${JSON.stringify(`(no element matches "${selector}")`)}; })()`
    : 'document.documentElement.outerHTML'
  const html: unknown = await pageContents().executeJavaScript(code)
  return typeof html === 'string' ? html : String(html)
}

export function getConsole(): { entries: ConsoleEntry[]; errors: number; warnings: number } {
  const errors = consoleLog.filter((e) => e.level >= 3).length
  const warnings = consoleLog.filter((e) => e.level === 2).length
  return { entries: [...consoleLog], errors, warnings }
}

export function currentUrl(): string | null {
  const v = activeView()
  return v ? v.webContents.getURL() : null
}

export function close(): void {
  if (win && !win.isDestroyed()) win.close()
  win = null
  tabs = []
  activeTabId = null
}

/** Open a new tab (optionally at a URL) and make it active. */
export function newTab(rawUrl?: string): void {
  ensureWindow()
  createTab(rawUrl)
}

/** Switch the visible tab. */
export function activateTab(id: string): void {
  if (!tabs.some((t) => t.id === id)) return
  activeTabId = id
  layout()
  pushState()
  pushTabs()
}

/** Reorder a tab to a new index in the strip (drag-to-reorder from the chrome). */
export function moveTab(id: string, toIndex: number): void {
  const from = tabs.findIndex((t) => t.id === id)
  if (from === -1) return
  const to = Math.max(0, Math.min(toIndex, tabs.length - 1))
  if (from === to) return
  const [tab] = tabs.splice(from, 1)
  tabs.splice(to, 0, tab)
  pushTabs()
}

/** Close a tab; activate a neighbour, or close the window if it was the last. */
export function closeTab(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx === -1) return
  const [tab] = tabs.splice(idx, 1)
  if (win && !win.isDestroyed()) win.removeBrowserView(tab.view)
  try {
    tab.view.webContents.close()
  } catch {
    // a removed view will be garbage-collected
  }
  if (activeTabId === id) {
    const next = tabs[idx] ?? tabs[idx - 1] ?? null
    if (next) {
      activeTabId = next.id
      layout()
      pushState()
    } else {
      close()
      return
    }
  }
  pushTabs()
}

/** Open (or focus) the browser window so the user can browse / sign in manually. */
export function openWindow(): void {
  ensureWindow()
  if (win?.isMinimized()) win.restore()
  win?.show()
  win?.focus()
  if (!pageContents().getURL()) void pageContents().loadURL(HOME_URL)
}

export async function navigate(rawUrl: string): Promise<void> {
  ensureWindow()
  try {
    await pageContents().loadURL(normalizeUrl(rawUrl))
  } catch {
    // surfaced via did-fail-load / the toolbar
  }
}

export function back(): void {
  const wc = activeView()?.webContents ?? null
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
}

export function forward(): void {
  const wc = activeView()?.webContents ?? null
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
}

export function reload(): void {
  activeView()?.webContents.reload()
}

export function stop(): void {
  activeView()?.webContents.stop()
}

/** Click the first element matching a CSS selector. */
export async function click(selector: string): Promise<string> {
  if (!selector.trim()) return 'browser_click: missing "selector"'
  const code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not-found'; el.scrollIntoView({ block: 'center' }); el.click(); return 'clicked'; })()`
  const r = await pageContents().executeJavaScript(code, true)
  return r === 'clicked' ? `Clicked ${selector}` : `No element matches "${selector}".`
}

/** Scroll the page: to a selector, or by direction (up/down/top/bottom). */
export async function scroll(opts: {
  selector?: string
  direction?: string
  amount?: number
}): Promise<string> {
  const { selector, direction, amount } = opts
  let code: string
  if (selector?.trim()) {
    code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not-found'; el.scrollIntoView({ behavior: 'instant', block: 'center' }); return 'ok'; })()`
  } else {
    const dy = typeof amount === 'number' ? amount : 700
    const expr =
      direction === 'top'
        ? 'window.scrollTo(0, 0)'
        : direction === 'bottom'
          ? 'window.scrollTo(0, document.body.scrollHeight)'
          : direction === 'up'
            ? `window.scrollBy(0, ${-dy})`
            : `window.scrollBy(0, ${dy})`
    code = `(() => { ${expr}; return 'ok'; })()`
  }
  const r = await pageContents().executeJavaScript(code, true)
  return r === 'not-found' ? `No element matches "${selector}".` : 'Scrolled.'
}

/** Type text into an input/textarea/contenteditable matching a selector. */
export async function type(selector: string, text: string): Promise<string> {
  if (!selector.trim()) return 'browser_type: missing "selector"'
  const code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not-found'; el.focus(); if ('value' in el) { el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } else { el.textContent = ${JSON.stringify(text)}; } return 'ok'; })()`
  const r = await pageContents().executeJavaScript(code, true)
  return r === 'ok' ? `Typed into ${selector}.` : `No element matches "${selector}".`
}
