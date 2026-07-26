import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, GitBranch, Plus, SquareStack } from 'lucide-react'
import type { Chat } from '@shared/types'
import { useRoxyStore } from '../lib/store'
import { workstreamStripView, statusKeyForSession } from '@shared/workstream'
import { cn } from '../lib/cn'

/**
 * The workstream strip — one quiet row under the composer answering "where does
 * this session's work land?".
 *
 *   ⌥ auth work  │  ⎇ roxy/auth  │  ○ local
 *
 * Deliberately a separate row from the composer's footer: that row is about HOW
 * the model runs (agent, model, context), this one is about WHERE the work goes.
 * It sits BELOW the composer because it's provenance, not input — the composer
 * stays the last thing between the caret and the send button.
 *
 * It renders NOTHING outside a git repo. Most folders aren't repos, and a
 * permanently greyed-out row would just be a nag.
 */

/** How often to re-poll git status while a session is on screen. */
const POLL_MS = 5_000

export function WorkstreamStrip(): JSX.Element | null {
  const chats = useRoxyStore((s) => s.chats)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const gitAvailable = useRoxyStore((s) => s.gitAvailable)
  const gitStatus = useRoxyStore((s) => s.gitStatus)
  const refreshGitStatus = useRoxyStore((s) => s.refreshGitStatus)

  const chat = chats.find((c) => c.id === activeChatId) ?? null
  // Which session's workstream to show, and whether to show anything at all,
  // is pure logic — it lives in shared/workstream.ts so it can be unit-tested.
  const owner =
    chat?.kind === 'sub' && chat.parentId
      ? (chats.find((c) => c.id === chat.parentId) ?? null)
      : chat
  const statusKey = owner ? statusKeyForSession(owner) : null
  const view = workstreamStripView({
    chat,
    findChat: (id) => chats.find((c) => c.id === id) ?? null,
    gitAvailable,
    status: statusKey ? gitStatus[statusKey] : undefined
  })

  // Poll rather than watch: N worktrees would mean N watchers, and fs.watch is
  // unreliable on Windows. Also refresh when the window regains focus, which is
  // when the user has most likely just committed something in another app.
  // Runs before the early return so polling starts even on the very first
  // render, when we don't yet know whether this folder is a repo.
  const ownerId = owner?.id
  useEffect(() => {
    if (!ownerId) return
    void refreshGitStatus(ownerId)
    const timer = setInterval(() => void refreshGitStatus(ownerId), POLL_MS)
    const onFocus = (): void => void refreshGitStatus(ownerId)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [ownerId, refreshGitStatus])

  if (!view || !owner) return null
  const { branch, dirty, readOnly, pending } = view
  const changed = (statusKey ? gitStatus[statusKey]?.changed : 0) ?? 0

  return (
    // Same px-4 gutter + centered max-w-3xl column as the composer, so the strip
    // reads as the composer's footer rather than a stray row pinned to the left.
    <div className="shrink-0 px-4 pb-2.5 text-xs">
      <div className="mx-auto flex max-w-3xl items-center gap-1 px-1">
        <WorkstreamSegment chat={owner} readOnly={readOnly} label={view.label} pending={pending} />

        <Divider />

        {/* Segment 2 — output, not a control. Switching a branch in place is a
            different (and riskier) action than opening a workstream; the
            workstream menu above is the branch picker. */}
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5 px-1.5 py-1',
            pending ? 'text-text-subtle' : 'text-text-muted'
          )}
          title={
            pending
              ? branch
                ? `Will check out ${branch} when this session starts`
                : 'Branch is chosen when this session starts'
              : branch
                ? `On branch ${branch}`
                : undefined
          }
        >
          <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
          {/* A pending 'new' workstream has no branch yet — its name is
              generated at materialization. Showing the CURRENT branch here
              would name the one thing this workstream exists to stay off. */}
          <span className="truncate">{branch ?? (pending ? 'branch pending' : 'detached')}</span>
          {dirty && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
              title={`${changed} uncommitted change${changed === 1 ? '' : 's'}`}
            />
          )}
        </span>

        <Divider />

        {/* Segment 3 — TODO: this becomes the branch lifecycle, and each state is
            reachable with plain git except the last two:
              ○ local  →  ↑N to push  →  pushed  →  PR #N  →  merged
            Clicking it should open a panel with the remote, ahead/behind, and
            commit/push actions. Left static here so the layout is final. */}
        <span
          className="flex items-center gap-1.5 px-1.5 py-1 text-text-subtle"
          title={pending ? 'Created when this session starts' : 'Not pushed yet'}
        >
          <span className="h-1.5 w-1.5 rounded-full border border-text-subtle/70" />
          {pending ? 'not created' : 'local'}
        </span>
      </div>
    </div>
  )
}

function Divider(): JSX.Element {
  return <span className="h-3.5 w-px shrink-0 bg-border" />
}

/**
 * Segment 1 — the workstream picker. This IS the branch picker: every workstream
 * is a branch, so a separate branch dropdown would be a second way to do the
 * same thing with worse semantics (switching a branch in the DEFAULT workstream
 * mutates the checkout every other session and the user's editor share).
 */
function WorkstreamSegment({
  chat,
  readOnly,
  label,
  pending
}: {
  chat: Chat
  readOnly: boolean
  label: string
  pending: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Click-outside + Escape, so the menu behaves like the rest of the app's
  // popovers even though this one is click-opened (ContextMeter is hover-opened,
  // which would be wrong for a menu with destructive-ish actions).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (readOnly) {
    return (
      <span
        className="flex min-w-0 items-center gap-1.5 px-1.5 py-1 text-text-subtle"
        title="Subagents run in the workstream that spawned them"
      >
        <SquareStack className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="truncate">{label}</span>
      </span>
    )
  }

  return (
    <div className="relative" ref={ref}>
      {open && <WorkstreamMenu chat={chat} onClose={() => setOpen(false)} />}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={
          pending
            ? 'This workstream is created when the session starts'
            : 'Workstreams — isolated checkouts you can run in parallel'
        }
        className={cn(
          'flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition hover:bg-white/5',
          open ? 'text-text' : 'text-text-muted hover:text-text'
        )}
      >
        <SquareStack className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="max-w-[12rem] truncate">{label}</span>
        {/* The one word that distinguishes "you are here" from "you will be
            here". Without it a pending workstream is indistinguishable from a
            live one, and the session silently looks like it edits the shared
            checkout. */}
        {pending && <span className="shrink-0 text-text-subtle">(pending)</span>}
        <ChevronDown
          className={cn('h-3 w-3 shrink-0 opacity-60 transition', open && 'rotate-180')}
        />
      </button>
    </div>
  )
}

/** The dropdown: this project's workstreams, plus ways to start a new one. */
function WorkstreamMenu({ chat, onClose }: { chat: Chat; onClose: () => void }): JSX.Element {
  const chats = useRoxyStore((s) => s.chats)
  const worktrees = useRoxyStore((s) => s.worktrees)
  const branches = useRoxyStore((s) => s.gitBranches)
  const gitStatus = useRoxyStore((s) => s.gitStatus)
  const refreshWorktrees = useRoxyStore((s) => s.refreshWorktrees)
  const newWorkstream = useRoxyStore((s) => s.newWorkstream)
  const selectChat = useRoxyStore((s) => s.selectChat)
  const [showBranches, setShowBranches] = useState(false)
  const [busy, setBusy] = useState(false)

  const workspace = chat.workspacePath ?? ''
  useEffect(() => {
    void refreshWorktrees(workspace)
  }, [workspace, refreshWorktrees])

  const defaultBranch = gitStatus[chat.worktreePath ?? workspace]?.defaultBranch ?? 'main'
  const projectWorktrees = worktrees[workspace] ?? []
  const projectBranches = branches[workspace] ?? []

  // The project's sessions ARE its workstreams; a worktree with no session is
  // still offered so a branch checked out elsewhere can be re-entered.
  const sessions = useMemo(
    () => chats.filter((c) => c.kind === 'main' && c.workspacePath === workspace),
    [chats, workspace]
  )
  /** Which session (if any) already lives on a branch — drives "open in …". */
  const sessionByBranch = useMemo(() => {
    const map = new Map<string, Chat>()
    for (const s of sessions) if (s.branch) map.set(s.branch, s)
    return map
  }, [sessions])

  // Other sessions' pending workstreams are deliberately NOT listed: there is
  // nothing to switch to yet, and git has not reserved the branch name.
  const inWorktree = sessions.filter((s) => s.worktreePath)
  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="absolute bottom-full left-0 z-50 w-72 pb-1.5">
      <div className="overflow-hidden rounded-xl border border-border bg-elevated py-1 shadow-2xl">
        <MenuLabel>Workstreams</MenuLabel>

        {/* The default workstream is the project folder itself — always present,
            and shown for orientation rather than as something to click. The tick
            means "this session is here", so a session waiting on its own
            worktree must NOT tick it — it is precisely the one place that
            session will not run. */}
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-text-subtle">
          <SquareStack className="h-3.5 w-3.5 opacity-70" />
          <span className="min-w-0 flex-1 truncate">default workstream</span>
          {!chat.worktreePath && !chat.worktreePending && (
            <Check className="h-3.5 w-3.5 text-accent" />
          )}
        </div>

        {/* A session whose worktree doesn't exist yet still belongs in the list:
            it is where the current session is going, and leaving it out makes
            the menu look like the "new workstream" click did nothing. */}
        {chat.worktreePending && !chat.worktreePath && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-text-subtle">
            <SquareStack className="h-3.5 w-3.5 opacity-70" />
            <span className="min-w-0 flex-1 truncate">{chat.title || 'new workstream'}</span>
            <span className="shrink-0 text-[11px]">pending</span>
            <Check className="h-3.5 w-3.5 text-accent" />
          </div>
        )}

        {inWorktree.map((s) => (
          <MenuItem
            key={s.id}
            onClick={() => void run(() => selectChat(s.id))}
            icon={<GitBranch className="h-3.5 w-3.5 opacity-70" />}
            trailing={s.id === chat.id ? <Check className="h-3.5 w-3.5 text-accent" /> : undefined}
            hint={s.branch ?? undefined}
          >
            {s.title}
          </MenuItem>
        ))}

        <div className="my-1 h-px bg-border" />

        {!showBranches ? (
          <>
            <MenuLabel>New workstream</MenuLabel>
            <MenuItem
              onClick={() =>
                void run(() => newWorkstream({ workspacePath: workspace, mode: 'new' }))
              }
              icon={<Plus className="h-3.5 w-3.5 opacity-70" />}
              hint={`off ${defaultBranch}`}
            >
              from {defaultBranch}
            </MenuItem>
            <MenuItem
              onClick={() => setShowBranches(true)}
              icon={<GitBranch className="h-3.5 w-3.5 opacity-70" />}
              trailing={<ChevronDown className="h-3 w-3 -rotate-90 opacity-60" />}
            >
              from an existing branch
            </MenuItem>
          </>
        ) : (
          <>
            <MenuLabel>
              <button
                type="button"
                onClick={() => setShowBranches(false)}
                className="transition hover:text-text"
              >
                ← branches
              </button>
            </MenuLabel>
            <div className="max-h-56 overflow-y-auto">
              {projectBranches.length === 0 && (
                <div className="px-3 py-1.5 text-[11px] text-text-subtle">No branches found.</div>
              )}
              {projectBranches.map((b) => {
                // A branch already checked out somewhere can't be checked out
                // again — git refuses. Attach to that worktree instead.
                const taken = projectWorktrees.find((w) => w.branch === b)
                const owner = sessionByBranch.get(b)
                return (
                  <MenuItem
                    key={b}
                    onClick={() =>
                      void run(async () => {
                        if (owner) return selectChat(owner.id)
                        return newWorkstream({
                          workspacePath: workspace,
                          mode: taken ? 'attach' : 'fromBranch',
                          branch: b
                        })
                      })
                    }
                    icon={<GitBranch className="h-3.5 w-3.5 opacity-70" />}
                    hint={taken ? (owner ? `↗ open in ${owner.title}` : '↗ open') : undefined}
                  >
                    {b}
                  </MenuItem>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function MenuLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="px-3 py-1 text-[11px] font-medium text-text-muted">{children}</div>
}

function MenuItem({
  children,
  onClick,
  icon,
  hint,
  trailing
}: {
  children: React.ReactNode
  onClick: () => void
  icon?: React.ReactNode
  hint?: string
  trailing?: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-muted transition hover:bg-white/5 hover:text-text"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[11px] text-text-subtle">{hint}</span>}
      {trailing}
    </button>
  )
}
