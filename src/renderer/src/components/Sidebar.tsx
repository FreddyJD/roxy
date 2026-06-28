import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronRight,
  FolderOpen,
  Hammer,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings as SettingsIcon,
  Trash2
} from 'lucide-react'
import type { Chat } from '@shared/types'
import { useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'
import { LoopsSection } from './LoopsSection'
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
}

export function Sidebar(): JSX.Element {
  const navigate = useNavigate()
  const chats = useRoxyStore((s) => s.chats)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const selectChat = useRoxyStore((s) => s.selectChat)
  const newSession = useRoxyStore((s) => s.newSession)
  const newSessionInProject = useRoxyStore((s) => s.newSessionInProject)
  const deleteChat = useRoxyStore((s) => s.deleteChat)
  const sendingChats = useRoxyStore((s) => s.sendingChats)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expandedSubs, setExpandedSubs] = useState<Set<string>>(new Set())
  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH
  })
  const [railed, setRailed] = useState<boolean>(() => localStorage.getItem(COLLAPSED_KEY) === '1')

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width))
  }, [width])
  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, railed ? '1' : '0')
  }, [railed])

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
        group = { path, name, sessions: [] }
        map.set(path, group)
      }
      return group
    }
    for (const c of chats) {
      if (c.kind !== 'main') continue
      ensure(c.workspacePath ?? '(no folder)').sessions.push(c)
    }
    return [...map.values()]
  }, [chats])

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
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-text"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          <button
            onClick={newSession}
            title="New session"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-text"
          >
            <FolderOpen className="h-4 w-4" />
          </button>
        </div>
        <button
          onClick={() => navigate('/settings')}
          title="Settings"
          className="mb-3 mt-auto flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-text"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
      </aside>
    )
  }

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="titlebar reserve-controls-left flex items-center justify-between px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <img
            src={roxy}
            alt="Roxy"
            className="h-7 w-7 rounded-lg object-cover ring-1 ring-border"
          />
          <span className="text-sm font-semibold tracking-tight">Roxy</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate('/settings')}
            title="Settings"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-text"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => setRailed(true)}
            title="Collapse sidebar"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-text"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-3">
        <button
          onClick={newSession}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-white text-sm font-medium text-black transition hover:bg-white/90"
        >
          <FolderOpen className="h-4 w-4" /> New session
        </button>
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3">
        <LoopsSection />

        <section className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-xs font-medium text-text-muted">Sessions</span>
            <button
              onClick={newSession}
              title="Open a folder as a new project"
              className="flex h-5 w-5 items-center justify-center rounded text-text-subtle transition hover:bg-white/5 hover:text-text"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {projects.length === 0 ? (
            <p className="px-1 text-xs text-text-subtle">
              No sessions yet — open a folder to start one.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {projects.map((project) => {
                const isCollapsed = collapsed.has(project.path)
                return (
                  <div key={project.path}>
                    <div className="flex items-center gap-1 px-1">
                      <button
                        onClick={() => toggleProject(project.path)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-text-muted transition hover:text-text"
                      >
                        <ChevronRight
                          className={cn(
                            'h-3 w-3 shrink-0 transition-transform',
                            !isCollapsed && 'rotate-90'
                          )}
                        />
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 opacity-70" />
                        <span className="truncate" title={project.path}>
                          {project.name}
                        </span>
                      </button>
                      <span className="shrink-0 text-[10px] tabular-nums text-text-subtle">
                        {project.sessions.length}
                      </span>
                      <button
                        onClick={() => void newSessionInProject(project.path)}
                        title="New session in this project"
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-subtle transition hover:bg-white/5 hover:text-text"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {!isCollapsed && (
                      <ul className="mt-0.5 flex flex-col gap-0.5 pl-2">
                        {project.sessions.map((chat) => {
                          const sending = !!sendingChats[chat.id]
                          const subs = subsByParent.get(chat.id) ?? []
                          const subsOpen = expandedSubs.has(chat.id)
                          return (
                            <li key={chat.id}>
                              <div
                                className={cn(
                                  'group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition',
                                  chat.id === activeChatId
                                    ? 'bg-elevated text-text'
                                    : 'text-text-muted hover:bg-white/5 hover:text-text'
                                )}
                              >
                                {sending ? (
                                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
                                ) : (
                                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-subtle/50" />
                                )}
                                <button
                                  onClick={() => selectChat(chat.id)}
                                  title={chat.title}
                                  className="min-w-0 flex-1 truncate text-left"
                                >
                                  {chat.title}
                                </button>
                                {subs.length > 0 && (
                                  <button
                                    onClick={() => toggleSubs(chat.id)}
                                    title={`${subs.length} subagent${subs.length === 1 ? '' : 's'} — tap to ${subsOpen ? 'hide' : 'view'}`}
                                    className="flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-surface-2 px-1 text-[10px] font-medium tabular-nums text-text-subtle transition hover:text-text"
                                  >
                                    {subs.length}
                                  </button>
                                )}
                                <button
                                  onClick={() => deleteChat(chat.id)}
                                  title="Delete session"
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-subtle opacity-0 transition hover:bg-white/5 hover:text-danger group-hover:opacity-100"
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
                                          'group/sub flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition',
                                          sub.id === activeChatId
                                            ? 'bg-elevated text-text'
                                            : 'text-text-muted hover:bg-white/5 hover:text-text'
                                        )}
                                      >
                                        <Hammer className="h-3 w-3 shrink-0 opacity-70" />
                                        <button
                                          onClick={() => selectChat(sub.id)}
                                          title={sub.title}
                                          className="min-w-0 flex-1 truncate text-left"
                                        >
                                          {sub.title}
                                        </button>
                                        <button
                                          onClick={() => deleteChat(sub.id)}
                                          title="Delete subagent session"
                                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-subtle opacity-0 transition hover:bg-white/5 hover:text-danger group-hover/sub:opacity-100"
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
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {/* Drag the right edge to resize; double-click to reset to the default width. */}
      <div
        onMouseDown={startResize}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        title="Drag to resize · double-click to reset"
        className="absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize transition hover:bg-accent/50"
      />
    </aside>
  )
}
