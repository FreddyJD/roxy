import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronRight,
  FolderOpen,
  Hammer,
  Lightbulb,
  MessageSquarePlus,
  MonitorSmartphone,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Repeat,
  Settings as SettingsIcon,
  Trash2
} from 'lucide-react'
import type { Chat, Loop } from '@shared/types'
import { formatInterval } from '@shared/format'
import { useRoxyStore } from '../lib/store'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { HeartbeatDot, NewLoopDialog } from './LoopsSection'
import { RemoteWorkspaceDialog } from './RemoteWorkspaceDialog'
import { BrailleSpinner } from './ThinkingIndicator'
import { UpdateCard } from './UpdateCard'
import roxy from '../assets/roxy.png'

const MIN_WIDTH = 220
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 288
const WIDTH_KEY = 'roxy.sidebar.width'
const COLLAPSED_KEY = 'roxy.sidebar.collapsed'
const clampWidth = (n: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n))

interface Project {
  path: string
  name: string
  sessions: Chat[]
  loops: Loop[]
}

export function Sidebar(): JSX.Element {
  const navigate = useNavigate()
  const chats = useRoxyStore((s) => s.chats)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const selectChat = useRoxyStore((s) => s.selectChat)
  const newSession = useRoxyStore((s) => s.newSession)
  const newSessionInProject = useRoxyStore((s) => s.newSessionInProject)
  const deleteChat = useRoxyStore((s) => s.deleteChat)
  const renameChat = useRoxyStore((s) => s.renameChat)
  const sendingChats = useRoxyStore((s) => s.sendingChats)
  const loops = useRoxyStore((s) => s.loops)
  const removeLoop = useRoxyStore((s) => s.removeLoop)
  const reorderSessions = useRoxyStore((s) => s.reorderSessions)
  const reorderProjects = useRoxyStore((s) => s.reorderProjects)
  const projectOrder = useRoxyStore((s) => s.projectOrder)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expandedSubs, setExpandedSubs] = useState<Set<string>>(new Set())
  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH
  })
  const [railed, setRailed] = useState<boolean>(() => localStorage.getItem(COLLAPSED_KEY) === '1')
  const [loopDialogFor, setLoopDialogFor] = useState<{ path: string; name: string } | null>(null)
  // Which project's "+" (new Session / Loop) menu is open, keyed by path.
  const [addMenuFor, setAddMenuFor] = useState<string | null>(null)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const remotePhase = useRoxyStore((s) => s.remote.phase)
  // Green only when truly live; amber while spinning up or reconnecting.
  const remoteDot: 'green' | 'amber' | null =
    remotePhase === 'live'
      ? 'green'
      : remotePhase === 'starting' || remotePhase === 'offline'
        ? 'amber'
        : null

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width))
  }, [width])
  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, railed ? '1' : '0')
  }, [railed])

  // Close the per-project "+" menu on any outside click or Escape.
  useEffect(() => {
    if (!addMenuFor) return
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('[data-add-menu]')) setAddMenuFor(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAddMenuFor(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [addMenuFor])

  // Double-click a session name to rename it inline. Enter / click-away saves,
  // Escape cancels. `cancelRef` lets the shared blur handler tell the two apart.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const cancelRef = useRef(false)

  // Drag-to-reorder sessions within a project (native HTML5 DnD, no dep). We track
  // the dragged session id + the id we're hovering over so the list can show a
  // drop indicator and reorder live; the persist happens on drop.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // Which edge of the hovered row we'd drop on. 'after' is what lets an item reach
  // the very bottom (drop onto the last row's lower half) — a before-only insert
  // structurally could never place anything past the last row.
  const [dropAfter, setDropAfter] = useState(false)

  // Drag-to-reorder whole projects (workspace folders). Kept separate from the
  // session DnD state above so a session drag never triggers a project reorder
  // (and vice-versa), even though their native drag events share the DOM tree.
  const [projectDrag, setProjectDrag] = useState<string | null>(null)
  const [projectDragOver, setProjectDragOver] = useState<string | null>(null)
  const [projectDropAfter, setProjectDropAfter] = useState(false)

  // Reorder `sessions` so `sourceId` lands just before/after `targetId`, returning
  // the new id order (or null when nothing actually moved / it's a cross-project drag).
  const reorderWithin = (
    sessions: Chat[],
    sourceId: string,
    targetId: string,
    place: 'before' | 'after'
  ): string[] | null => {
    const ids = sessions.map((s) => s.id)
    const from = ids.indexOf(sourceId)
    if (from === -1 || ids.indexOf(targetId) === -1) return null
    ids.splice(from, 1)
    ids.splice(ids.indexOf(targetId) + (place === 'after' ? 1 : 0), 0, sourceId)
    // Bail if the order is unchanged (e.g. dropped onto your own current slot) so
    // we don't fire a pointless persist + refresh.
    if (ids.every((id, i) => id === sessions[i].id)) return null
    return ids
  }

  const onSessionDrop = (project: Project, targetId: string): void => {
    const source = dragId
    const place = dropAfter ? 'after' : 'before'
    setDragId(null)
    setDragOverId(null)
    setDropAfter(false)
    if (!source || source === targetId) return
    const order = reorderWithin(project.sessions, source, targetId, place)
    if (order) void reorderSessions(project.path === '(no folder)' ? null : project.path, order)
  }

  const beginRename = (chat: Chat): void => {
    cancelRef.current = false
    setDraftTitle(chat.title)
    setEditingId(chat.id)
  }

  const commitRename = (): void => {
    const id = editingId
    if (!id) return
    setEditingId(null)
    if (cancelRef.current) {
      cancelRef.current = false
      return
    }
    const next = draftTitle.trim()
    const current = chats.find((c) => c.id === id)
    if (next && current && next !== current.title) void renameChat(id, next)
  }

  const onRenameKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelRef.current = true
      e.currentTarget.blur()
    }
  }

  // Drag the right edge to resize; the window listeners live only during a drag.
  const startResize = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent): void => setWidth(clampWidth(startW + ev.clientX - startX))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // A project = a workspace folder; main sessions group under it.
  const projects = useMemo<Project[]>(() => {
    const map = new Map<string, Project>()
    const ensure = (path: string): Project => {
      let group = map.get(path)
      if (!group) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
        group = { path, name, sessions: [], loops: [] }
        map.set(path, group)
      }
      return group
    }
    for (const c of chats) {
      if (c.kind !== 'main') continue
      ensure(c.workspacePath ?? '(no folder)').sessions.push(c)
    }
    // Loops belong to a project too — group them by their chat's workspace.
    const chatPath = new Map(chats.map((c) => [c.id, c.workspacePath]))
    for (const loop of loops) {
      ensure(chatPath.get(loop.chatId) ?? '(no folder)').loops.push(loop)
    }
    const groups = [...map.values()]
    // Order by the user's saved project order; unknowns (a just-created project
    // not yet in projectOrder, or the '(no folder)' catch-all) fall to the bottom.
    // Array.sort is stable, so those keep their newest-first insertion order.
    const rank = new Map(projectOrder.map((p, i) => [p, i]))
    return groups.sort(
      (a, b) =>
        (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER)
    )
  }, [chats, loops, projectOrder])

  // Reorder projects so the dragged folder lands before/after the drop target,
  // then persist. Only real folders take part — the '(no folder)' catch-all
  // isn't a registered project, so it always stays pinned at the bottom.
  const onProjectDrop = (targetPath: string): void => {
    const source = projectDrag
    const place = projectDropAfter ? 'after' : 'before'
    setProjectDrag(null)
    setProjectDragOver(null)
    setProjectDropAfter(false)
    if (!source || source === targetPath || targetPath === '(no folder)') return
    const current = projects.map((p) => p.path).filter((p) => p !== '(no folder)')
    const from = current.indexOf(source)
    if (from === -1 || current.indexOf(targetPath) === -1) return
    const paths = current.slice()
    paths.splice(from, 1)
    paths.splice(paths.indexOf(targetPath) + (place === 'after' ? 1 : 0), 0, source)
    if (paths.every((p, i) => p === current[i])) return
    void reorderProjects(paths)
  }

  // Subagent sessions grouped by the main chat that spawned them.
  const subsByParent = useMemo(() => {
    const map = new Map<string, Chat[]>()
    for (const c of chats) {
      if (c.kind !== 'sub' || !c.parentId) continue
      const list = map.get(c.parentId)
      if (list) list.push(c)
      else map.set(c.parentId, [c])
    }
    return map
  }, [chats])

  const toggleSubs = (id: string): void =>
    setExpandedSubs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleProject = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  if (railed) {
    return (
      <aside className="flex h-full w-14 shrink-0 flex-col items-center border-r border-border bg-surface">
        <div className="titlebar reserve-controls-left h-[54px] w-full shrink-0" />
        <div className="flex flex-col items-center gap-1 pt-1">
          <button
            onClick={() => setRailed(false)}
            title="Expand sidebar"
            className="press-scale flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          <button
            onClick={newSession}
            title="New project"
            className="press-scale flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <FolderOpen className="h-4 w-4" />
          </button>
        </div>
        <div className="mb-3 mt-auto flex flex-col items-center gap-1">
          <button
            onClick={() => setRemoteOpen(true)}
            title="Remote Workspace"
            className="relative press-scale flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <MonitorSmartphone className="h-4 w-4" />
            {remoteDot && (
              <span
                className={cn(
                  'absolute right-1 top-1 h-1.5 w-1.5 rounded-full ring-2 ring-surface',
                  remoteDot === 'green' ? 'bg-success' : 'bg-warning'
                )}
              />
            )}
          </button>
          <button
            onClick={() => navigate('/skills')}
            title="Skills"
            className="press-scale flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <Lightbulb className="h-4 w-4" />
          </button>
          <button
            onClick={() => navigate('/mcp')}
            title="MCP Servers"
            className="press-scale flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <Plug className="h-4 w-4" />
          </button>
          <button
            onClick={() => navigate('/settings')}
            title="Settings"
            className="press-scale flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>
        {remoteOpen && <RemoteWorkspaceDialog onClose={() => setRemoteOpen(false)} />}
      </aside>
    )
  }

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="titlebar reserve-controls-left flex items-center gap-2 px-4 py-3.5">
        <div className="sidebar-brand flex items-center gap-2.5">
          <img
            src={roxy}
            alt="Roxy"
            className="h-7 w-7 rounded-lg object-cover ring-1 ring-border"
          />
          <span className="text-sm font-semibold tracking-tight">Roxy</span>
        </div>
        <div className="sidebar-controls ml-auto flex items-center gap-1">
          <button
            onClick={() => navigate('/settings')}
            title="Settings"
            className="press-scale flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => setRailed(true)}
            title="Collapse sidebar"
            className="press-scale flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-3">
        <button
          onClick={newSession}
          title="Open a folder as a new project"
          className="press-scale flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-white text-sm font-medium text-black hover:bg-white/90"
        >
          <FolderOpen className="h-4 w-4" /> New project
        </button>
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center px-1">
            <span className="text-xs font-medium text-text-muted">Projects</span>
          </div>
          {projects.length === 0 ? (
            <p className="px-1 text-xs text-text-subtle">
              No sessions yet — open a folder to start one.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {projects.map((project) => {
                const isCollapsed = collapsed.has(project.path)
                const canDragProject = project.path !== '(no folder)'
                return (
                  <div
                    key={project.path}
                    className={cn(
                      'relative',
                      projectDrag === project.path && 'opacity-40',
                      projectDragOver === project.path &&
                        projectDrag &&
                        projectDrag !== project.path &&
                        (projectDropAfter
                          ? 'after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent'
                          : 'before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-accent')
                    )}
                    onDragOver={(e) => {
                      if (!projectDrag || !canDragProject) return
                      e.preventDefault()
                      if (projectDrag === project.path) return
                      const r = e.currentTarget.getBoundingClientRect()
                      const after = e.clientY - r.top > r.height / 2
                      if (projectDragOver !== project.path) setProjectDragOver(project.path)
                      if (after !== projectDropAfter) setProjectDropAfter(after)
                    }}
                    onDrop={(e) => {
                      if (!projectDrag) return
                      e.preventDefault()
                      onProjectDrop(project.path)
                    }}
                  >
                    <div
                      className={cn('flex items-center gap-1 px-1', projectDrag && 'cursor-grabbing')}
                      draggable={canDragProject}
                      onDragStart={(e) => {
                        if (!canDragProject) return
                        setProjectDrag(project.path)
                        e.dataTransfer.effectAllowed = 'move'
                        e.stopPropagation()
                      }}
                      onDragEnd={() => {
                        setProjectDrag(null)
                        setProjectDragOver(null)
                        setProjectDropAfter(false)
                      }}
                    >
                      <button
                        onClick={() => toggleProject(project.path)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-text-muted transition-colors hover:text-text"
                      >
                        <ChevronRight
                          className={cn(
                            'h-3 w-3 shrink-0 transition-transform duration-200 ease-out-quart',
                            !isCollapsed && 'rotate-90'
                          )}
                        />
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 opacity-70" />
                        <span className="truncate" title={project.path}>
                          {project.name}
                        </span>
                      </button>
                      {project.path !== '(no folder)' ? (
                        <div className="relative shrink-0" data-add-menu>
                          <button
                            onClick={() =>
                              setAddMenuFor((cur) => (cur === project.path ? null : project.path))
                            }
                            title="New session or loop"
                            className={cn(
                              'flex h-5 w-5 items-center justify-center rounded text-text-subtle transition-colors hover:bg-white/5 hover:text-text',
                              addMenuFor === project.path && 'bg-white/5 text-text'
                            )}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                          {addMenuFor === project.path && (
                            <div className="animate-pop-in absolute right-0 top-6 z-30 w-36 origin-top-right overflow-hidden rounded-lg border border-border bg-elevated py-1 shadow-lg">
                              <button
                                onClick={() => {
                                  setAddMenuFor(null)
                                  void newSessionInProject(project.path)
                                }}
                                className="press-scale flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-muted hover:bg-white/5 hover:text-text"
                              >
                                <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
                                Session
                              </button>
                              <button
                                onClick={() => {
                                  setAddMenuFor(null)
                                  setLoopDialogFor({ path: project.path, name: project.name })
                                }}
                                className="press-scale flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-muted hover:bg-white/5 hover:text-text"
                              >
                                <Repeat className="h-3.5 w-3.5 shrink-0" />
                                Loop
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={() => void newSessionInProject(project.path)}
                          title="New session in this project"
                          className="press-scale flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-subtle hover:bg-white/5 hover:text-text"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {!isCollapsed && (
                      <>
                        {project.loops.length > 0 && (
                          <ul className="mb-0.5 flex flex-col gap-0.5 pl-2">
                            {project.loops.map((loop) => (
                              <li key={loop.id}>
                                <div
                                  className={cn(
                                    'group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                                    loop.chatId === activeChatId
                                      ? 'bg-elevated text-text'
                                      : 'text-text-muted hover:bg-white/5 hover:text-text'
                                  )}
                                >
                                  <HeartbeatDot enabled={loop.enabled} />
                                  <button
                                    onClick={() => selectChat(loop.chatId)}
                                    title={loop.name}
                                    className="min-w-0 flex-1 text-left"
                                  >
                                    <span className="block truncate">{loop.name}</span>
                                    <span className="block text-[11px] text-text-subtle">
                                      every {formatInterval(loop.intervalMinutes)}
                                      {loop.enabled ? '' : ' · paused'}
                                    </span>
                                  </button>
                                  <button
                                    onClick={() => removeLoop(loop.id)}
                                    title="Delete loop"
                                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-subtle opacity-0 transition-[opacity,color,background-color] hover:bg-white/5 hover:text-danger group-hover:opacity-100"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                        <ul className="mt-0.5 flex flex-col gap-0.5 pl-2">
                          {project.sessions.map((chat) => {
                            const sending = !!sendingChats[chat.id]
                            const subs = subsByParent.get(chat.id) ?? []
                            const subsOpen = expandedSubs.has(chat.id)
                            return (
                              <li
                                key={chat.id}
                                // Only the whole row is draggable when not renaming;
                                // the inline input stays editable during a rename.
                                draggable={editingId !== chat.id}
                                onDragStart={(e) => {
                                  setDragId(chat.id)
                                  e.dataTransfer.effectAllowed = 'move'
                                }}
                                onDragEnter={() =>
                                  dragId && dragId !== chat.id && setDragOverId(chat.id)
                                }
                                onDragOver={(e) => {
                                  if (!dragId) return
                                  e.preventDefault() // allow drop
                                  if (dragId === chat.id) return
                                  // Top half → drop before this row; bottom half → after.
                                  // The 'after' branch is what makes the bottom reachable.
                                  const r = e.currentTarget.getBoundingClientRect()
                                  const after = e.clientY - r.top > r.height / 2
                                  if (dragOverId !== chat.id) setDragOverId(chat.id)
                                  if (after !== dropAfter) setDropAfter(after)
                                }}
                                onDrop={(e) => {
                                  e.preventDefault()
                                  onSessionDrop(project, chat.id)
                                }}
                                onDragEnd={() => {
                                  setDragId(null)
                                  setDragOverId(null)
                                  setDropAfter(false)
                                }}
                                className={cn(
                                  'relative',
                                  dragId === chat.id && 'opacity-40',
                                  // Drop indicator: a hairline on the edge we'd insert at
                                  // (top for 'before', bottom for 'after').
                                  dragOverId === chat.id &&
                                    dragId !== chat.id &&
                                    (dropAfter
                                      ? 'after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent'
                                      : 'before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-accent')
                                )}
                              >
                                <div
                                  className={cn(
                                    'group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                                    dragId && 'cursor-grabbing',
                                    chat.id === activeChatId
                                      ? 'bg-elevated text-text'
                                      : 'text-text-muted hover:bg-white/5 hover:text-text'
                                  )}
                                >
                                  {sending ? (
                                    <BrailleSpinner className="shrink-0 text-sm text-accent" />
                                  ) : (
                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-subtle/50" />
                                  )}
                                  {editingId === chat.id ? (
                                    <input
                                      autoFocus
                                      value={draftTitle}
                                      onChange={(e) => setDraftTitle(e.target.value)}
                                      onKeyDown={onRenameKeyDown}
                                      onBlur={commitRename}
                                      onFocus={(e) => e.currentTarget.select()}
                                      onClick={(e) => e.stopPropagation()}
                                      className="min-w-0 flex-1 rounded border border-accent/60 bg-bg px-1.5 py-0.5 text-sm text-text outline-none"
                                    />
                                  ) : (
                                    <button
                                      onClick={() => selectChat(chat.id)}
                                      onDoubleClick={() => beginRename(chat)}
                                      title={chat.title}
                                      className="min-w-0 flex-1 truncate text-left"
                                    >
                                      {chat.title}
                                    </button>
                                  )}
                                  {subs.length > 0 && (
                                    <button
                                      onClick={() => toggleSubs(chat.id)}
                                      title={`${subs.length} subagent${subs.length === 1 ? '' : 's'} — tap to ${subsOpen ? 'hide' : 'view'}`}
                                      className="flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-surface-2 px-1 text-[10px] font-medium tabular-nums text-text-subtle transition-colors hover:text-text"
                                    >
                                      {subs.length}
                                    </button>
                                  )}
                                  <button
                                    onClick={() => deleteChat(chat.id)}
                                    title="Delete session"
                                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-subtle opacity-0 transition-[opacity,color,background-color] hover:bg-white/5 hover:text-danger group-hover:opacity-100"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                                {subsOpen && subs.length > 0 && (
                                  <ul className="mt-0.5 ml-3 flex flex-col gap-0.5 border-l border-border pl-2">
                                    {subs.map((sub) => (
                                      <li key={sub.id}>
                                        <div
                                          className={cn(
                                            'group/sub flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition-colors',
                                            sub.id === activeChatId
                                              ? 'bg-elevated text-text'
                                              : 'text-text-muted hover:bg-white/5 hover:text-text'
                                          )}
                                        >
                                          <Hammer className="h-3 w-3 shrink-0 opacity-70" />
                                          {editingId === sub.id ? (
                                            <input
                                              autoFocus
                                              value={draftTitle}
                                              onChange={(e) => setDraftTitle(e.target.value)}
                                              onKeyDown={onRenameKeyDown}
                                              onBlur={commitRename}
                                              onFocus={(e) => e.currentTarget.select()}
                                              onClick={(e) => e.stopPropagation()}
                                              className="min-w-0 flex-1 rounded border border-accent/60 bg-bg px-1.5 py-0.5 text-xs text-text outline-none"
                                            />
                                          ) : (
                                            <button
                                              onClick={() => selectChat(sub.id)}
                                              onDoubleClick={() => beginRename(sub)}
                                              title={sub.title}
                                              className="min-w-0 flex-1 truncate text-left"
                                            >
                                              {sub.title}
                                            </button>
                                          )}
                                          <button
                                            onClick={() => deleteChat(sub.id)}
                                            title="Delete subagent session"
                                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-subtle opacity-0 transition-[opacity,color,background-color] hover:bg-white/5 hover:text-danger group-hover/sub:opacity-100"
                                          >
                                            <Trash2 className="h-3 w-3" />
                                          </button>
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {loopDialogFor && (
        <NewLoopDialog
          workspacePath={loopDialogFor.path}
          projectName={loopDialogFor.name}
          onClose={() => setLoopDialogFor(null)}
        />
      )}

      {remoteOpen && <RemoteWorkspaceDialog onClose={() => setRemoteOpen(false)} />}

      <CustomizeNav onOpenRemote={() => setRemoteOpen(true)} remoteDot={remoteDot} />

      <UpdateCard />

      {/* Drag the right edge to resize; double-click to reset to the default width. */}
      <div
        onMouseDown={startResize}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        title="Drag to resize · double-click to reset"
        className="absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-accent/50"
      />
    </aside>
  )
}

/** Counts of discovered skills + configured MCP servers, refreshed when focused. */
function useCustomizeCounts(): { skills: number; mcp: number } {
  const [counts, setCounts] = useState<{ skills: number; mcp: number }>({ skills: 0, mcp: 0 })
  useEffect(() => {
    let alive = true
    const load = (): void => {
      Promise.all([api.skills.list(), api.mcp.list()])
        .then(([skills, mcp]) => {
          if (alive) setCounts({ skills: skills.length, mcp: mcp.length })
        })
        .catch(() => {})
    }
    load()
    // Re-count when the window regains focus (the user may have edited skills/MCP on a page).
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.removeEventListener('focus', load)
    }
  }, [])
  return counts
}

/**
 * The "Customize" section pinned to the bottom of the sidebar — quick access to
 * Remote Workspace (share to phone), plus the Skills and MCP Servers pages
 * (à la VS Code's Customizations panel), with a live count/indicator on each.
 */
function CustomizeNav({
  onOpenRemote,
  remoteDot
}: {
  onOpenRemote: () => void
  remoteDot: 'green' | 'amber' | null
}): JSX.Element {
  const navigate = useNavigate()
  const counts = useCustomizeCounts()
  const items: {
    label: string
    icon: typeof Lightbulb
    onClick: () => void
    count?: number
    dot?: 'green' | 'amber' | null
  }[] = [
    { label: 'Remote Workspace', icon: MonitorSmartphone, onClick: onOpenRemote, dot: remoteDot },
    { label: 'Skills', icon: Lightbulb, onClick: () => navigate('/skills'), count: counts.skills },
    { label: 'MCP Servers', icon: Plug, onClick: () => navigate('/mcp'), count: counts.mcp }
  ]
  return (
    <div className="border-t border-border px-3 py-2">
      <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
        Customize
      </span>
      <div className="mt-1 flex flex-col gap-0.5">
        {items.map((it) => (
          <button
            key={it.label}
            onClick={it.onClick}
            className="press-scale flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-text-muted hover:bg-white/5 hover:text-text"
          >
            <it.icon className="h-4 w-4 shrink-0 opacity-80" />
            <span className="flex-1 text-left">{it.label}</span>
            {it.dot ? (
              <span
                className="relative flex h-2 w-2 shrink-0"
                title={it.dot === 'green' ? 'Sharing — live' : 'Sharing — connecting'}
              >
                <span
                  className={cn(
                    'absolute inline-flex h-full w-full animate-ping rounded-full opacity-70',
                    it.dot === 'green' ? 'bg-success' : 'bg-warning'
                  )}
                />
                <span
                  className={cn(
                    'relative inline-flex h-2 w-2 rounded-full',
                    it.dot === 'green' ? 'bg-success' : 'bg-warning'
                  )}
                />
              </span>
            ) : (
              it.count !== undefined &&
              it.count > 0 && (
                <span className="shrink-0 text-[10px] tabular-nums text-text-subtle">
                  {it.count}
                </span>
              )
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
