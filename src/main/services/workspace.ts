/**
 * Where a session's work actually happens.
 *
 * `sessionCwd()` is the ONLY working-directory resolver in the app: the agent
 * turn, tool runs, shell commands and the phone header all go through it. A
 * session normally works directly in the project folder the user opened, but a
 * worktree-backed session works in its own isolated checkout instead — that's
 * what lets several agents run in parallel without sharing one filesystem.
 *
 * If you ever find yourself writing a second cwd-resolution path, don't: every
 * consumer must agree, or a session will read from one tree and write to
 * another.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as repo from '../db/repo'
import { resolveWorktreeCwd } from '../../shared/workspace'

/** How far `sessionCwd` will follow `parentId` before giving up (cycle guard). */
const MAX_PARENT_DEPTH = 32

/**
 * Walk up from `dir` looking for a `.git` entry; returns the repo root if found.
 *
 * Note `.git` is a FILE (not a directory) inside a worktree, so `existsSync`
 * rather than a directory check — this must resolve a repo root from inside a
 * worktree too.
 */
export function findGitRoot(dir: string): string | undefined {
  let cur = dir
  for (let i = 0; i < 64 && cur; i++) {
    try {
      if (existsSync(path.join(cur, '.git'))) return cur
    } catch {
      /* ignore unreadable dirs */
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * The absolute directory a session's tools operate in, or '' when it has no
 * workspace (loops, and sessions created before a folder was picked).
 *
 * Resolution order:
 *   1. no chat / no workspace          -> ''
 *   2. sub-session                     -> its parent's cwd (subagents always
 *                                         work in the tree that spawned them)
 *   3. no worktree                     -> the project folder, as before
 *   4. worktree                        -> the matching path inside it, keeping
 *                                         any sub-path of the repo the project
 *                                         folder pointed at
 */
export function sessionCwd(chatId: string): string {
  if (!chatId) return ''
  let id = chatId
  const seen = new Set<string>()
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    if (seen.has(id)) return ''
    seen.add(id)
    const chat = repo.getChat(id)
    if (!chat) return ''
    // Subagents never own a worktree — they run in their parent's tree, so the
    // parent's worktree (or lack of one) decides for both.
    if (chat.kind === 'sub' && chat.parentId) {
      id = chat.parentId
      continue
    }
    const workspacePath = chat.workspacePath
    if (!workspacePath) return ''
    if (!chat.worktreePath) return workspacePath
    return resolveWorktreeCwd(
      workspacePath,
      chat.worktreePath,
      findGitRoot(workspacePath) ?? null,
      path
    )
  }
  // Runaway parent chain — treat it as unresolvable rather than loop forever.
  return ''
}
