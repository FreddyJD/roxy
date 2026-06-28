/**
 * Loop heartbeat scheduler. Every tick it fires any enabled loops whose
 * next run is due: it appends the loop's prompt + a heartbeat response to the
 * loop's chat, then broadcasts so open windows refresh live.
 *
 * Each heartbeat uses the real list_sessions data, demonstrating the tools a
 * loop will drive once the model + agent loop are wired.
 */
import { BrowserWindow } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type { Loop } from '../../shared/types'
import * as repo from '../db/repo'

const CHECK_INTERVAL_MS = 30_000

let timer: ReturnType<typeof setInterval> | null = null

export function startLoopScheduler(): void {
  if (timer) return
  timer = setInterval(tick, CHECK_INTERVAL_MS)
  // Run shortly after startup so freshly created / due loops fire promptly.
  setTimeout(tick, 3_000)
}

export function stopLoopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

function tick(): void {
  const now = Date.now()
  let due: Loop[]
  try {
    due = repo.dueLoops(now)
  } catch {
    return
  }
  for (const loop of due) {
    // Advance the schedule here; the renderer runs the real agent turn on tick.
    repo.markLoopRan(loop.id)
    broadcast(loop.id)
  }
}

function broadcast(loopId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CHANNELS.loopsTick, loopId)
  }
}
