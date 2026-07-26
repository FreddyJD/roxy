/**
 * main -> renderer pushes for session rows that MAIN changes on its own.
 *
 * Most session mutations are renderer-initiated (`chats:rename`, `chats:create`)
 * so the store refreshes off the call it just made. Three are not, and they are
 * exactly the ones the workstream strip displays:
 *
 *   - `worktree_path` + `branch`, written by lazy worktree materialization on
 *     the first turn (services/worktree.ts);
 *   - `branch` again, when the agent retitles its own session and the branch
 *     follows (syncBranchToTitle);
 *   - `dev_port`, allocated alongside the worktree.
 *
 * Without a push, the renderer's copy of those fields stays whatever it was when
 * the session was created — i.e. empty — for the WHOLE first turn, which can be
 * many minutes. The strip renders "(pending) / branch pending" the entire time
 * even though the worktree exists and the agent is already writing files in it.
 *
 * Broadcast to every window rather than replying to one, for the same reason
 * background-tasks.ts does: the write happens on the turn path, which may have
 * been started by the phone (remote host) or by a loop heartbeat, so there is no
 * "the window that asked" to answer.
 */
import { BrowserWindow } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type { SessionsUpdated } from '../../shared/api'

/**
 * Tell every window that session rows changed and why.
 *
 * `reason` is not decoration: the renderer does strictly more work for
 * `worktree` (it has to prime git status for a path key it has never polled)
 * than for a plain metadata change, and guessing from a diff of the chat list
 * would be both slower and easy to get wrong.
 *
 * Never throws. This rides along with worktree creation on the turn path, and a
 * torn-down window must not be able to fail a turn.
 */
export function emitSessionsUpdated(payload: SessionsUpdated): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.chatsUpdated, payload)
    } catch {
      // window went away mid-send — ignore
    }
  }
}
