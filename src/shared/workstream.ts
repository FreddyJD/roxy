/**
 * Pure decision logic for the workstream strip — extracted from the component so
 * the rules can be unit-tested without a renderer (`npm run smoke:shared`).
 *
 * The rules are small but easy to get subtly wrong, and every one of them is a
 * visible bug: a strip that flashes and vanishes, a sub-session offering a
 * dropdown that would move its parent's tree, or a permanent greyed-out row in
 * every non-git folder.
 */

/** The minimal session shape the strip cares about. */
export interface StripSession {
  id: string
  title: string
  kind: string
  parentId: string | null
  workspacePath: string | null
  worktreePath: string | null
  branch: string | null
}

/** The minimal git status shape the strip cares about. */
export interface StripGitStatus {
  isRepo: boolean
  branch: string | null
  dirty: boolean
  changed: number
}

export interface StripView {
  /** The session whose workstream is displayed (a sub shows its PARENT's). */
  ownerId: string
  /** Key into the polled status map: the worktree, else the project folder. */
  statusKey: string | null
  label: string
  branch: string | null
  dirty: boolean
  /** Sub-sessions inherit their workstream and must not offer the dropdown. */
  readOnly: boolean
  inWorktree: boolean
}

/**
 * What the strip should show, or null to render NOTHING.
 *
 * Hidden (not greyed out) when there's no session, no workspace, no git binary,
 * or the folder isn't a repository — most folders aren't repos, and a permanent
 * disabled row would just be a nag. Also hidden until the first status arrives,
 * so it doesn't flash on and back off.
 */
export function workstreamStripView(input: {
  chat: StripSession | null
  /** Looked up by id — a sub-session's workstream belongs to its parent. */
  findChat: (id: string) => StripSession | null
  gitAvailable: boolean | null
  status: StripGitStatus | undefined
}): StripView | null {
  const { chat, findChat, gitAvailable, status } = input
  if (!chat) return null
  if (gitAvailable === false) return null

  // Subagents run in the tree that spawned them, so they display the parent's
  // workstream — read-only, since acting on it would move the parent.
  const owner = chat.kind === 'sub' && chat.parentId ? findChat(chat.parentId) : chat
  if (!owner?.workspacePath) return null

  // Only real sessions get the dropdown: a sub inherits, and a loop has no
  // workstream of its own to change.
  const readOnly = chat.kind !== 'main'
  if (!status?.isRepo) return null

  return {
    ownerId: owner.id,
    statusKey: owner.worktreePath ?? owner.workspacePath,
    label: owner.worktreePath ? owner.title || 'workstream' : 'default workstream',
    branch: owner.branch ?? status.branch,
    dirty: status.dirty,
    readOnly,
    inWorktree: !!owner.worktreePath
  }
}

/**
 * Which status entry a session polls, or null when it shouldn't poll at all.
 *
 * Keyed by WORKTREE path so N sessions sharing one worktree share a single
 * poll, and sub-sessions never poll separately from their parent.
 */
export function statusKeyForSession(chat: StripSession): string | null {
  if (chat.kind === 'sub') return null
  return chat.worktreePath ?? chat.workspacePath
}
