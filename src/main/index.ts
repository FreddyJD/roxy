import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import macDockIcon from '../../resources/icon-mac.png?asset'
import { registerIpc } from './ipc'
import { getDb } from './db/database'
import { startLoopScheduler } from './services/loops'
import { listModels } from './services/models'
import { backfillUsageFromHistory } from './services/usage'
import { listConnectedProviders } from './db/repo'
import { setAppIcon, closeAll as closeAllBrowsers } from './services/browser'
import { cleanupToolOutputs } from './services/tool-output-store'
import { cancelAllBackgroundJobs } from './services/background-tasks'
import { shutdownAllLsp } from './services/lsp'
import { shutdownAllMcp } from './services/mcp'
import { shutdownRemote } from './services/remote'
import { initAutoUpdater } from './services/updater'
import { killAllBackground, setPromptText, setAgentPromptText } from './harness'
import { PROMPT_TEXT, AGENT_PROMPT_TEXT } from '../shared/prompt-text'

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    // On macOS an AppKit vibrancy view sits behind the web contents; it can
    // only show through if the window itself paints nothing. Every other
    // platform keeps the solid near-black, which also avoids a flash of white
    // between window creation and first paint.
    backgroundColor: isMac ? '#00000000' : '#0a0a0a',
    title: 'Roxy',
    // Native window controls, themed to match the app (no light OS title bar).
    titleBarStyle: 'hidden',
    ...(isMac
      ? {
          trafficLightPosition: { x: 16, y: 17 },
          /*
           * Translucent ("glass") sidebar — macOS only, deliberately.
           *
           * `sidebar` is the same NSVisualEffectView material Finder and Mail
           * use for their source lists, so this reads as genuinely native
           * rather than as a CSS imitation of one. Vibrancy is a *whole-window*
           * effect, so the sidebar-only look comes from leaving only the
           * sidebar translucent while every content pane paints opaque on top
           * of it (see `.vibrancy-pane` / `.vibrancy-solid` in main.css).
           *
           * We deliberately do NOT set `transparent: true`. It's the usual
           * advice online, but on macOS it disables the native rounded corners
           * and window shadow, and it isn't needed for vibrancy to composite.
           *
           * Windows is intentionally excluded: `backgroundMaterial: 'acrylic'`
           * degrades to a flat light-grey slab whenever the user has Settings →
           * Personalization → Colors → "Transparency effects" off (which we
           * can't detect from Electron), is unavailable before Win11 22H2, and
           * paints black when maximized on Electron < 36. Verified by
           * measurement on Win11 23H2 + Electron 33 and 38.
           */
          vibrancy: 'sidebar',
          /*
           * The default (`followWindow`) swaps to AppKit's lighter "inactive"
           * material whenever the app loses focus. Nothing else in Roxy changes
           * appearance on blur, so a sidebar that alone jumps lighter reads as a
           * rendering glitch rather than as a focus cue. Pin the active state.
           */
          visualEffectState: 'active'
        }
      : { titleBarOverlay: { color: '#0a0a0a', symbolColor: '#9a9aa3', height: 48 } }),
    ...(isMac ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Open external links in the user's browser instead of a new Electron window.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the Vite dev server in development, or the built HTML in production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

/**
 * Warm the models.dev catalog for each connected provider (so `modelCost` can
 * price rows), then run the one-time history backfill. Fully best-effort — any
 * failure just leaves backfilled rows unpriced, which real turns fill in later.
 */
async function warmCatalogThenBackfill(): Promise<void> {
  try {
    const providers = listConnectedProviders()
    // Pull each provider's catalog once; listModels caches it process-wide, which
    // is exactly what modelCost() reads from.
    await Promise.allSettled(providers.map((p) => listModels(p.id)))
  } catch {
    // ignore — backfill still runs, just possibly unpriced
  }
  backfillUsageFromHistory()
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.roxy.app')
  // Give the agent's browser window the Roxy icon too (no asset import in the
  // browser service so the smoke's esbuild bundle stays happy).
  setAppIcon(icon)
  // Inject the tuned per-model + per-agent prompt text into the harness (imported
  // via `?raw` here in the Vite-built entry, so the esbuild smoke bundle never
  // sees it).
  setPromptText(PROMPT_TEXT)
  setAgentPromptText(AGENT_PROMPT_TEXT)

  if (process.platform === 'darwin') {
    // Use the padded variant so the dock icon matches Apple's size convention
    // (the full-bleed resources/icon.png would render oversized next to native apps).
    app.dock?.setIcon(macDockIcon)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Open the database (runs migrations) and wire up IPC before the first window.
  getDb()
  registerIpc()
  startLoopScheduler()
  // Sweep tool-output spill files older than the retention window (best-effort).
  void cleanupToolOutputs()
  // One-time: seed the usage/cost table from existing message history so the
  // dashboard isn't empty after upgrading. Warm the models.dev catalog first so
  // backfilled rows can be priced (else they'd all cost $0). Best-effort + async.
  void warmCatalogThenBackfill()

  const mainWindow = createWindow()
  initAutoUpdater(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Kill any agent-started background processes (dev servers/watchers) on quit,
// cancel any in-flight background subagent tasks (Phase 11), and shut down any
// warm language servers (Phase 12).
app.on('will-quit', () => {
  killAllBackground()
  cancelAllBackgroundJobs()
  closeAllBrowsers()
  shutdownAllLsp()
  void shutdownAllMcp()
  shutdownRemote()
})
