import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { CHANNELS } from '../../shared/ipc'
import type { UpdateState } from '../../shared/api'

/**
 * Auto-updates via GitHub Releases (electron-updater). The packaged app reads
 * the generated `app-update.yml` (owner/repo baked in from electron-builder's
 * `publish` config) to find the latest release, downloads it in the background,
 * and offers to restart. No-ops in a dev/unpacked build, and never crashes the
 * app on a failed check (offline, no releases yet, unsigned mac, …).
 */

/** Re-check for updates this often while the app stays open. */
const CHECK_INTERVAL_MS = 1000 * 60 * 60 * 6 // 6 hours

let win: BrowserWindow | null = null
let state: UpdateState = { status: 'idle' }

function setState(next: UpdateState): void {
  state = next
  if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.updateStatus, next)
}

export function getUpdateState(): UpdateState {
  return state
}

export function initAutoUpdater(window: BrowserWindow): void {
  win = window
  // Only meaningful in a packaged app — dev builds have no update feed.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    setState({ status: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', () => setState({ status: 'not-available' }))
  autoUpdater.on('download-progress', (p) =>
    setState({ status: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'downloaded', version: info.version })
    void promptRestart(info.version)
  })
  autoUpdater.on('error', (err) =>
    setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
  )

  void checkForUpdates()
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
}

/** Trigger a check now (startup, the 6h timer, and the Settings button). */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    setState({ status: 'not-available' })
    return
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

/** Quit and install a downloaded update (relaunches the app). */
export function quitAndInstall(): void {
  if (!app.isPackaged) return
  // Defer so the IPC reply can flush before the app tears down.
  setImmediate(() => autoUpdater.quitAndInstall())
}

async function promptRestart(version: string): Promise<void> {
  if (!win || win.isDestroyed()) return
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `Roxy ${version} has been downloaded.`,
    detail: 'Restart the app to finish installing the update.'
  })
  if (response === 0) quitAndInstall()
}
