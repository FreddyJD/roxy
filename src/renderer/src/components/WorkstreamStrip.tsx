import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { LifecycleAction, LifecycleTone, ForgeKind, SyncTarget } from '@shared/forge'
import { FORGE_NAMES, relativeAge } from '@shared/forge'
import { api } from '../lib/api'
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  GitBranch,
  Plus,
  RotateCcw,
  SquareStack
} from 'lucide-react'
import type { Chat } from '@shared/types'
import { useRoxyStore } from '../lib/store'
import { workstreamStripView, statusKeyForSession } from '@shared/workstream'
import { branchNameError } from '@shared/branch'
import { worktreeSlug } from '@shared/format'
import { ServicesSegment, useServices } from './ServicesSegment'
import { useMenuAnchor } from '../lib/useMenuAnchor'
import { cn } from '../lib/cn'
// The tone -> class mapping is shared with the sidebar's row badge. Two copies
// would drift, and a `merged` PR that is green in one place and grey in the
// other teaches the user that the colour means nothing.
import { TONE_BG, TONE_TEXT } from '../lib/lifecycle'
import { Scroller } from './Scroller'

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

/**
 * Menu widths in px, not Tailwind classes, because `useMenuAnchor` needs the
 * number to keep each menu inside the window. The strip is a centered row whose
 * segments can sit anywhere across it, so every menu here is one narrow window
 * away from hanging off an edge — the numbers must match the rendered widths.
 */
const WORKSTREAM_MENU_W = 288
/** Wide enough to fit "Update from origin/some-branch" on one line. */
const FORGE_PANEL_W = 340
const HOST_MENU_W = 224

export function WorkstreamStrip(): JSX.Element | null {
  const chats = useRoxyStore((s) => s.chats)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const gitAvailable = useRoxyStore((s) => s.gitAvailable)
  const gitStatus = useRoxyStore((s) => s.gitStatus)
  const refreshGitStatus = useRoxyStore((s) => s.refreshGitStatus)
  // Hooked unconditionally: services exist outside git repos too, and this
  // keeps the list warm for the segment below.
  const { services, sessionId: serviceSessionId } = useServices()

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

  // Services are NOT git-scoped — a dev server runs in any folder — so when
  // there is no repo to describe, the row still appears for them alone rather
  // than taking the processes down with it.
  if (!view || !owner) {
    if (!services.length || !serviceSessionId) return null
    return (
      <StripRow>
        <ServicesSegment services={services} sessionId={serviceSessionId} />
      </StripRow>
    )
  }

  const { branch, dirty, readOnly, pending } = view
  const changed = (statusKey ? gitStatus[statusKey]?.changed : 0) ?? 0

  return (
    <StripRow>
      <WorkstreamSegment chat={owner} readOnly={readOnly} label={view.label} pending={pending} />

      <Divider />

      {/* Segment 2 — the branch, renameable in place. Generated names
          (`roxy/6fdc60b8`) say nothing about the work, and the name is what ends
          up on the PR, so renaming has to be reachable from where you read it
          rather than from a terminal. Switching branches is still NOT offered
          here: that is the workstream menu's job, and doing it in the default
          workstream would mutate the checkout every other session and the user's
          editor share. */}
      <BranchSegment
        sessionId={owner.id}
        branch={branch}
        pending={pending}
        dirty={dirty}
        changed={changed}
        readOnly={readOnly}
      />

      <Divider />

      {/* Segment 3 — the branch lifecycle:
            local -> up-N to push -> pushed -> PR #N -> merged
          Clicking opens the remote panel. */}
      <LifecycleChip ownerId={owner.id} statusKey={statusKey} />

      {/* Last, and only when there is something to say. Processes are the most
          volatile thing in the row, so they sit at the end where a changing
          width cannot shove the branch name around. */}
      {services.length > 0 && serviceSessionId && (
        <>
          <Divider />
          <ServicesSegment services={services} sessionId={serviceSessionId} />
        </>
      )}
    </StripRow>
  )
}

/**
 * The row itself: same px-4 gutter and centered max-w-3xl column as the
 * composer, so the strip reads as the composer's footer rather than a stray row
 * pinned to the left.
 */
function StripRow({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="shrink-0 px-4 pb-2.5 text-xs">
      <div className="mx-auto flex max-w-3xl items-center gap-1 px-1">{children}</div>
    </div>
  )
}

/**
 * Segment 3 - where the work stands relative to the remote.
 *
 * The states form one line, and the chip's whole job is to answer "is this
 * done?" at a glance:
 *
 *   local  ->  up-N  ->  pushed  ->  #42  ->  merged
 *
 * The first three come from git and render offline and instantly. The last two
 * need the host, so they arrive a moment later - which is why the chip never
 * shows a spinner or an empty state: it always displays the best answer it
 * currently has, and quietly upgrades. A chip that flickered between "local"
 * and "#42" every poll would be worse than no chip.
 */
function LifecycleChip({
  ownerId,
  statusKey
}: {
  ownerId: string
  statusKey: string | null
}): JSX.Element | null {
  const forgeStatus = useRoxyStore((s) => s.forgeStatus)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const anchor = useMenuAnchor(ref, open, FORGE_PANEL_W, { align: 'end' })

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

  const view = statusKey ? forgeStatus[statusKey] : undefined
  // Render nothing until the first status lands, rather than a placeholder that
  // would visibly swap a moment later.
  if (!view) return null

  // An unrecognised host is the one case the chip cannot answer on its own.
  // Asking here rather than only in Settings matters: this is the moment the
  // user cares, and it is one click instead of a hunt through preferences.
  if (view.unknownHost) return <UnknownHostChip host={view.unknownHost} />

  const { lifecycle } = view

  return (
    <div className="relative" ref={ref}>
      {open && (
        <ForgePanel
          ownerId={ownerId}
          statusKey={statusKey}
          style={anchor}
          onClose={() => setOpen(false)}
        />
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={lifecycle.title}
        className={cn(
          'flex items-center gap-1.5 rounded-md px-1.5 py-1 transition hover:bg-white/5',
          TONE_TEXT[lifecycle.tone]
        )}
      >
        <StateDot tone={lifecycle.tone} filled={lifecycle.phase !== 'unpublished'} />
        <span className="tabular-nums">{lifecycle.label}</span>
      </button>
    </div>
  )
}

/**
 * `git.mycorp.com` could be GitLab, Bitbucket Server or Azure DevOps Server,
 * and the domain gives nothing away. Guessing would mean firing authenticated
 * requests at an unrelated server, so we ask - once, then never again.
 */
function UnknownHostChip({ host }: { host: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const anchor = useMenuAnchor(ref, open, HOST_MENU_W, { align: 'end' })
  const refreshGitStatus = useRoxyStore((s) => s.refreshGitStatus)
  const activeChatId = useRoxyStore((s) => s.activeChatId)

  const pick = async (kind: ForgeKind): Promise<void> => {
    await api.forge.setHostKind(host, kind)
    setOpen(false)
    if (activeChatId) await refreshGitStatus(activeChatId)
  }

  return (
    <div className="relative" ref={ref}>
      {open && (
        <div className="absolute bottom-full z-50 flex flex-col pb-1.5" style={anchor}>
          <Scroller className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-border bg-elevated py-1 shadow-2xl">
            <div className="px-3 py-1.5 text-[11px] text-text-subtle">
              What does <span className="text-text-muted">{host}</span> run?
            </div>
            {FORGE_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => void pick(k)}
                className="flex w-full items-center px-3 py-1.5 text-left text-xs text-text-muted transition hover:bg-white/5 hover:text-text"
              >
                {FORGE_NAMES[k]}
              </button>
            ))}
          </Scroller>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Roxy doesn't recognise ${host} - click to choose`}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-text-subtle transition hover:bg-white/5 hover:text-text-muted"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
        set up
      </button>
    </div>
  )
}

const FORGE_KINDS: ForgeKind[] = ['github', 'azure-devops', 'gitlab', 'bitbucket']

/**
 * Hollow while the work is local, filled once it exists on the server. It's the
 * same visual grammar as an unread dot, and it means the two most common states
 * are distinguishable without reading the label.
 */
function StateDot({ tone, filled }: { tone: LifecycleTone; filled: boolean }): JSX.Element {
  return filled ? (
    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_BG[tone])} />
  ) : (
    <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-text-subtle/70" />
  )
}

/**
 * The panel behind the chip: who the host is, what the PR is, and what to do
 * about it.
 *
 * It has two tiers, and the split is the whole design:
 *
 *   PRIMARY   one button, the obvious next step for the current state (push,
 *             open a PR, view it). Never more than one — a panel offering push,
 *             pull, open-PR and view-PR all at once makes the user decide
 *             something the app already knows.
 *
 *   SYNC      "Update from origin/main" and "Reset to origin/main", shown only
 *             when there is actually an upstream to sync with. These are the
 *             answer to a chip that used to say "Behind origin" and then tell
 *             you to go run git yourself — which is a status light pretending
 *             to be a button.
 *
 * Reset is deliberately the quieter of the two and asks for a second click. It
 * is the only control here that can throw away work.
 */
function ForgePanel({
  ownerId,
  statusKey,
  style,
  onClose
}: {
  ownerId: string
  statusKey: string | null
  /** Width + edge-clamped offset + height cap, from useMenuAnchor. */
  style: CSSProperties
  onClose: () => void
}): JSX.Element {
  const forgeStatus = useRoxyStore((s) => s.forgeStatus)
  const gitStatus = useRoxyStore((s) => s.gitStatus)
  const pushBranch = useRoxyStore((s) => s.pushBranch)
  const pullBranch = useRoxyStore((s) => s.pullBranch)
  const resetBranch = useRoxyStore((s) => s.resetBranch)
  const [busy, setBusy] = useState<null | 'action' | 'pull' | 'reset'>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** Reset is armed by a first click and fires on the second. */
  const [confirmReset, setConfirmReset] = useState(false)

  const view = statusKey ? forgeStatus[statusKey] : undefined
  const git = statusKey ? gitStatus[statusKey] : undefined
  const pull = view?.pull ?? null
  const action = view?.lifecycle.action ?? null
  const sync = view?.syncTarget ?? null

  // Disarm as soon as the panel's numbers move: an armed "Reset" that was aimed
  // at "3 behind" must not silently fire at a different tree after a poll.
  useEffect(() => {
    setConfirmReset(false)
  }, [sync?.upstream, sync?.behind, sync?.ahead, sync?.changed])

  const openUrl = (url: string): void => {
    void api.system.openExternal(url)
    onClose()
  }

  /** Wrap an action so every path reports through the same two lines. */
  const perform = async (
    kind: 'action' | 'pull' | 'reset',
    fn: () => Promise<void>
  ): Promise<void> => {
    if (busy) return
    setBusy(kind)
    setError(null)
    setNote(null)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const runPrimary = (): Promise<void> =>
    perform('action', async () => {
      if (action === 'view-pr' && pull) return openUrl(pull.url)
      if (action === 'open-pr') {
        const url = statusKey ? await api.forge.createUrl(statusKey) : null
        // A missing URL means we couldn't determine the base branch. Saying so
        // beats opening a compare page pointed at the wrong target.
        if (!url) return setError('Could not work out the base branch for this PR.')
        return openUrl(url)
      }
      if (action === 'push') {
        const r = await pushBranch(ownerId)
        if (!r.ok) setError(r.error ?? 'Push failed.')
        return
      }
      // 'pull' has its own dedicated button below; the primary slot skips it.
    })

  const runPull = (): Promise<void> =>
    perform('pull', async () => {
      const r = await pullBranch(ownerId)
      if (!r.ok) return setError(r.error ?? 'Could not update from origin.')
      setNote(r.updated ? `Updated from ${r.upstream}.` : 'Already up to date.')
    })

  const runReset = (): Promise<void> =>
    perform('reset', async () => {
      const r = await resetBranch(ownerId)
      setConfirmReset(false)
      if (!r.ok) return setError(r.error ?? 'Reset failed.')
      // Naming the stash is the point. A destructive action that hides the way
      // back is indistinguishable from one that lost the work.
      setNote(
        r.stashed
          ? `Reset to ${r.upstream}. Your changes are in the stash — \`git stash pop\` to get them back.`
          : `Reset to ${r.upstream}.`
      )
    })

  return (
    <div className="absolute bottom-full z-50 flex flex-col pb-1.5" style={style}>
      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
            {view?.remote ? view.remote.slug : 'No remote'}
          </span>
          {view?.remote && (
            <span className="shrink-0 text-[11px] text-text-subtle">
              {FORGE_NAMES[view.remote.kind]}
            </span>
          )}
        </div>

        {pull ? (
          <button
            type="button"
            onClick={() => openUrl(pull.url)}
            className="flex w-full flex-col gap-1 px-3 py-2 text-left transition hover:bg-white/5"
          >
            <span className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-text">#{pull.number}</span>
              <span className="truncate text-xs text-text-muted">{pull.title}</span>
            </span>
            <span className="text-[11px] text-text-subtle">
              {pull.author ? `${pull.author} - ` : ''}
              {relativeAge(pull.updatedAt || pull.createdAt, Date.now())}
              {pull.targetBranch ? ` - into ${pull.targetBranch}` : ''}
            </span>
          </button>
        ) : (
          <div className="px-3 py-2 text-[11px] text-text-subtle">
            {view?.lifecycle.title ?? 'No pull request'}
          </div>
        )}

        {/* Ahead/behind is shown as raw numbers rather than folded into prose:
            it's the one thing people cross-check against their terminal. */}
        {git && git.hasUpstream && (git.ahead > 0 || git.behind > 0) && (
          <div className="flex gap-3 border-t border-border px-3 py-1.5 text-[11px] text-text-subtle tabular-nums">
            {git.ahead > 0 && <span>{git.ahead} ahead</span>}
            {git.behind > 0 && <span>{git.behind} behind</span>}
          </div>
        )}

        {(error || view?.error) && (
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-warning">
            {error ?? view?.error?.message}
          </div>
        )}
        {note && !error && (
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-text-muted">
            {note}
          </div>
        )}

        {/* `pull` never reaches the primary slot — it has a labelled button of
            its own below, where it sits next to the reset it might send you to. */}
        {action && action !== 'pull' && (
          <div className="border-t border-border p-1.5">
            <button
              type="button"
              onClick={() => void runPrimary()}
              disabled={!!busy}
              className="press-scale flex w-full items-center justify-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-xs text-text hover:bg-white/5 disabled:opacity-50"
            >
              {busy === 'action' ? 'Working...' : ACTION_LABEL[action]}
            </button>
          </div>
        )}

        {sync && (
          <div className="flex flex-col gap-1 border-t border-border p-1.5">
            <button
              type="button"
              onClick={() => void runPull()}
              // Nothing to fast-forward, or a fast-forward that git would
              // refuse. Disabled with a reason beats a button that fails.
              disabled={!!busy || !sync.canFastForward}
              title={fastForwardHint(sync)}
              className="press-scale flex w-full items-center justify-center gap-1.5 rounded-lg bg-surface-2 px-3 py-1.5 text-xs text-text hover:bg-white/5 disabled:opacity-40"
            >
              <ArrowDownToLine className="h-3.5 w-3.5 opacity-70" />
              {/* Two labels, because they are two different promises. With
                  commits known to be waiting it says what it will DO; with none
                  it says what it will LOOK FOR, since the count is only as
                  fresh as the last fetch and clicking is how you refresh it. */}
              {busy === 'pull'
                ? 'Updating...'
                : sync.behind > 0
                  ? `Update from ${sync.upstream}`
                  : `Check ${sync.upstream}`}
              {sync.behind > 0 && (
                <span className="text-text-subtle tabular-nums">({sync.behind})</span>
              )}
            </button>

            {/* Two clicks, not a dialog. The panel already shows the counts this
                would discard, so a modal would only re-state what is on screen
                two inches above the cursor — while a single click on a button
                that throws away work is how people learn to distrust an app. */}
            <button
              type="button"
              onClick={() => (confirmReset ? void runReset() : setConfirmReset(true))}
              onBlur={() => setConfirmReset(false)}
              disabled={!!busy}
              title={`Discard local state and make this branch identical to ${sync.upstream}`}
              className={cn(
                'press-scale flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs disabled:opacity-40',
                confirmReset
                  ? 'bg-danger/15 text-danger'
                  : 'text-text-subtle hover:bg-white/5 hover:text-text-muted'
              )}
            >
              <RotateCcw className="h-3.5 w-3.5 opacity-70" />
              {busy === 'reset'
                ? 'Resetting...'
                : confirmReset
                  ? resetConfirmLabel(sync)
                  : `Reset to ${sync.upstream}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * What "Update" will do, or why it can't — shown on the button, before the
 * click rather than as an error after it.
 */
function fastForwardHint(sync: SyncTarget): string {
  if (!sync.canFastForward) {
    return sync.behind > 0
      ? `Diverged from ${sync.upstream} — merge or rebase it yourself, or reset to discard the local commits`
      : `${sync.ahead} unpushed commit${sync.ahead === 1 ? '' : 's'} — push them, or reset to discard them`
  }
  // No count means the last fetch found nothing; clicking fetches again, so
  // this doubles as "check for new commits".
  return sync.behind > 0
    ? `Fast-forward this branch onto ${sync.upstream}`
    : `Check ${sync.upstream} for new commits`
}

/**
 * The armed label spells out the damage in units the user can weigh: commits
 * are gone for good (well, reflog), edits are merely stashed. "Are you sure?"
 * says nothing; "Discard 2 commits + stash 5 changes" is a decision.
 */
function resetConfirmLabel(sync: SyncTarget): string {
  const bits: string[] = []
  if (sync.ahead > 0) bits.push(`discard ${sync.ahead} commit${sync.ahead === 1 ? '' : 's'}`)
  if (sync.changed > 0) bits.push(`stash ${sync.changed} change${sync.changed === 1 ? '' : 's'}`)
  if (!bits.length) return 'Click again to reset'
  return `Click again to ${bits.join(' + ')}`
}

const ACTION_LABEL: Record<LifecycleAction, string> = {
  push: 'Push to origin',
  pull: 'Update from origin',
  'open-pr': 'Open a pull request',
  'view-pr': 'View on the web'
}

function Divider(): JSX.Element {
  return <span className="h-3.5 w-px shrink-0 bg-border" />
}

/**
 * Segment 2 — the branch name, editable in place.
 *
 * Click to edit, Enter to save, Escape to cancel. Deliberately not a modal: the
 * name is short, the edit is reversible, and a dialog for a nine-character
 * string is ceremony. The input is validated as you type against the same rules
 * the main process uses (`shared/branch`), so the failure mode is a disabled
 * button with a reason rather than a git `fatal:` after the fact.
 *
 * Renaming is safe while the branch is checked out — git rewrites the
 * worktree's HEAD in place and leaves uncommitted work alone.
 */
function BranchSegment({
  sessionId,
  branch,
  pending,
  dirty,
  changed,
  readOnly
}: {
  sessionId: string
  branch: string | null
  pending: boolean
  dirty: boolean
  changed: number
  readOnly: boolean
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const refreshChats = useRoxyStore((s) => s.refreshChats)

  // A pending workstream has no branch to rename yet, and a sub-session must
  // not move its parent's branch.
  const canRename = !!branch && !pending && !readOnly

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const start = (): void => {
    if (!canRename) return
    setDraft(branch ?? '')
    setError(null)
    setEditing(true)
  }

  const cancel = (): void => {
    setEditing(false)
    setError(null)
  }

  const save = async (): Promise<void> => {
    const next = draft.trim()
    if (!next || next === branch) return cancel()
    const problem = branchNameError(next)
    if (problem) return setError(problem)

    setSaving(true)
    const res = await window.roxy.git.renameBranch(sessionId, next)
    setSaving(false)
    if (!res.ok) return setError(res.error ?? 'Could not rename the branch.')
    // The branch lives on the chat row, so the strip re-reads it from there.
    await refreshChats()
    setEditing(false)
  }

  if (editing) {
    return (
      <span className="relative flex min-w-0 items-center gap-1.5 px-1.5 py-1 text-text">
        <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <input
          ref={inputRef}
          value={draft}
          autoFocus
          disabled={saving}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') cancel()
          }}
          // Blur saves rather than discards: losing a rename to a stray click
          // is the more annoying of the two failure modes, and Escape is
          // right there for the other one.
          onBlur={() => void save()}
          spellCheck={false}
          className={cn(
            'min-w-0 flex-1 rounded border bg-surface px-1 py-0.5 text-xs outline-none',
            error ? 'border-danger' : 'border-border-strong'
          )}
          style={{ width: `${Math.max(draft.length + 2, 12)}ch` }}
        />
        {error && (
          <span
            role="alert"
            className="absolute bottom-full left-0 mb-1 whitespace-nowrap rounded-md border border-danger/40 bg-elevated px-2 py-1 text-[11px] text-danger shadow-lg"
          >
            {error}
          </span>
        )}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={!canRename}
      title={
        pending
          ? branch
            ? `Will check out ${branch} when this session starts`
            : 'Branch is chosen when this session starts'
          : canRename
            ? `On branch ${branch} — click to rename`
            : branch
              ? `On branch ${branch}`
              : undefined
      }
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition',
        pending ? 'text-text-subtle' : 'text-text-muted',
        canRename && 'hover:bg-white/5 hover:text-text'
      )}
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
      {/* A pending 'new' workstream has no branch yet — its name is generated
          at materialization. Showing the CURRENT branch here would name the one
          thing this workstream exists to stay off. */}
      <span className="truncate">{branch ?? (pending ? 'branch pending' : 'detached')}</span>
      {dirty && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
          title={`${changed} uncommitted change${changed === 1 ? '' : 's'}`}
        />
      )}
    </button>
  )
}

/**
 * Tooltip for anything that names a workstream.
 *
 * The point is the FOLDER. A workstream's directory is named once, from the
 * session's opening title, and never renamed; the branch then drifts away from
 * it as `syncBranchToTitle` retitles the branch to match what the session turned
 * out to be about. That is good for stable paths (open editors and dev servers
 * keep working) but it means the sidebar, the branch and the directory on disk
 * can all read differently, with no way to tell which folder a session owns.
 * Surfacing the slug on hover makes that answerable without leaving the app.
 *
 * Only shown for real worktrees: a session in the default workstream has no
 * folder of its own, and a pending one has no folder yet.
 */
function workstreamTitle(chat: Chat, pending: boolean, base?: string): string {
  const fallback =
    base ??
    (pending
      ? 'This workstream is created when the session starts'
      : 'Workstreams — isolated checkouts you can run in parallel')
  const slug = worktreeSlug(chat.worktreePath)
  return slug ? `${fallback}\nFolder: ${slug}` : fallback
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
  const anchor = useMenuAnchor(ref, open, WORKSTREAM_MENU_W)

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
        title={workstreamTitle(chat, false, 'Subagents run in the workstream that spawned them')}
      >
        <SquareStack className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="truncate">{label}</span>
      </span>
    )
  }

  return (
    <div className="relative" ref={ref}>
      {open && <WorkstreamMenu chat={chat} style={anchor} onClose={() => setOpen(false)} />}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={workstreamTitle(chat, pending)}
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
function WorkstreamMenu({
  chat,
  style,
  onClose
}: {
  chat: Chat
  /** Width + edge-clamped offset + height cap, from useMenuAnchor. */
  style: CSSProperties
  onClose: () => void
}): JSX.Element {
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
    <div className="absolute bottom-full z-50 flex flex-col pb-1.5" style={style}>
      {/* The whole menu scrolls, not just the branch list: a project with a
          dozen sessions makes the workstream list itself taller than the window,
          and `maxHeight` without `overflow` would only clip it differently. */}
      <Scroller className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-border bg-elevated py-1 shadow-2xl">
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
            // The row already shows title + branch; the folder is the third
            // identity a workstream has, and the only one you need when
            // matching a session against what is actually on disk.
            title={workstreamTitle(s, false)}
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
            <Scroller className="max-h-56 overflow-y-auto">
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
            </Scroller>
          </>
        )}
      </Scroller>
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
  trailing,
  title
}: {
  children: React.ReactNode
  onClick: () => void
  icon?: React.ReactNode
  hint?: string
  trailing?: React.ReactNode
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-muted transition hover:bg-white/5 hover:text-text"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[11px] text-text-subtle">{hint}</span>}
      {trailing}
    </button>
  )
}
