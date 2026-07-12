import { useEffect, useRef, useState } from 'react'
import { ChevronRight, FolderOpen, ListTree, Loader2, Repeat, Settings } from 'lucide-react'
import { useRoxyStore } from '../lib/store'
import { formatInterval } from '@shared/format'
import { cn } from '../lib/cn'
import { MessageBubble } from './MessageBubble'
import { Composer } from './Composer'
import { LoopDetailsPane } from './LoopDetailsPane'
import { SessionInfo } from './SessionInfo'
import { QueuedMessage } from './QueuedMessage'
import { UsageMeter } from './UsageMeter'
import {
  Queue,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger
} from './Queue'
import { Button } from './ui'
import roxy from '../assets/roxy.png'

/** Only render the most recent N messages — older ones stay in the DB but off-screen. */
/** Render the latest N messages; scrolling to the top reveals PAGE more. */
const VISIBLE_MESSAGES = 8
const PAGE = 8

export function ChatView(): JSX.Element {
  const messages = useRoxyStore((s) => s.messages)
  const streaming = useRoxyStore((s) =>
    s.activeChatId ? (s.streamingChats[s.activeChatId] ?? null) : null
  )
  const sending = useRoxyStore((s) => (s.activeChatId ? !!s.sendingChats[s.activeChatId] : false))
  const submit = useRoxyStore((s) => s.submit)
  const stop = useRoxyStore((s) => s.stop)
  const queue = useRoxyStore((s) => s.queue)
  const newSession = useRoxyStore((s) => s.newSession)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const chats = useRoxyStore((s) => s.chats)
  const loops = useRoxyStore((s) => s.loops)
  const backgroundTaskCount = useRoxyStore((s) =>
    s.activeChatId ? (s.runningTasks[s.activeChatId]?.length ?? 0) : 0
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow the conversation only while you're already at the bottom. If you've
  // scrolled up to read history, new messages/stream chunks must NOT yank you
  // back down — resume following once you scroll back to the end.
  const stickToBottom = useRef(true)
  const [loopPaneOpen, setLoopPaneOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  // Show only the latest N; scrolling up loads older ones a page at a time.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_MESSAGES)
  const restoreHeight = useRef<number | null>(null)

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    // Near the top with more history → reveal another page, preserving position.
    if (el.scrollTop < 80 && visibleCount < messages.length) {
      restoreHeight.current = el.scrollHeight
      setVisibleCount((c) => Math.min(messages.length, c + PAGE))
    }
  }

  // Switching chats starts you pinned to the latest message + collapses details.
  useEffect(() => {
    stickToBottom.current = true
    setInfoOpen(false)
    setVisibleCount(VISIBLE_MESSAGES)
  }, [activeChatId])

  // Keep the scroll anchored when older messages prepend (no jump to the top).
  useEffect(() => {
    const el = scrollRef.current
    if (el && restoreHeight.current !== null) {
      el.scrollTop += el.scrollHeight - restoreHeight.current
      restoreHeight.current = null
    }
  }, [visibleCount])

  useEffect(() => {
    if (!stickToBottom.current) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streaming])

  const activeChat = chats.find((c) => c.id === activeChatId)
  const activeLoop = loops.find((l) => l.chatId === activeChatId)
  const sessionTasks = activeChat?.tasks ?? []
  const tasksDone = sessionTasks.filter((t) => t.status === 'completed').length
  const hasSessionInfo =
    activeChat?.kind === 'main' && (!!activeChat.description?.trim() || sessionTasks.length > 0)

  // No workspace open — prompt to open a folder to start a session.
  if (!activeChat) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col bg-bg">
        <div className="titlebar reserve-controls-right h-12 shrink-0" />
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <img
            src={roxy}
            alt="Roxy"
            className="h-16 w-16 rounded-2xl object-cover shadow-lg ring-1 ring-border"
          />
          <h1 className="mt-5 text-xl font-semibold">Open a workspace</h1>
          <p className="mt-1.5 max-w-xs text-sm text-text-muted">
            Pick a folder to start an agent session.
          </p>
          <Button variant="primary" className="mt-5" onClick={newSession}>
            <FolderOpen className="h-4 w-4" /> Open folder
          </Button>
        </div>
      </div>
    )
  }

  const isEmpty = messages.length === 0 && (streaming === null || streaming.length === 0)

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-bg">
      <header className="titlebar reserve-controls-right flex h-12 shrink-0 items-center justify-between gap-3 px-4">
        {activeLoop ? (
          <div className="flex min-w-0 items-center gap-2">
            <Repeat className="h-4 w-4 shrink-0 text-text-muted" />
            <span className="shrink-0 text-sm font-medium">{activeChat.title}</span>
            <span className="truncate text-xs text-text-subtle">
              every {formatInterval(activeLoop.intervalMinutes)} ·{' '}
              {activeLoop.enabled ? 'running' : 'paused'}
            </span>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <FolderOpen className="h-4 w-4 shrink-0 text-text-muted" />
            <span className="shrink-0 text-sm font-medium">{activeChat.title}</span>
            {activeChat.workspacePath && (
              <span className="truncate text-xs text-text-subtle" title={activeChat.workspacePath}>
                {activeChat.workspacePath}
              </span>
            )}
            {hasSessionInfo && (
              <button
                onClick={() => setInfoOpen((o) => !o)}
                title="Description & tasks"
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
                  infoOpen
                    ? 'bg-elevated text-text'
                    : 'text-text-muted hover:bg-white/5 hover:text-text'
                )}
              >
                <ListTree className="h-3.5 w-3.5" />
                {sessionTasks.length > 0 && (
                  <span className="tabular-nums">
                    {tasksDone}/{sessionTasks.length}
                  </span>
                )}
                <ChevronRight
                  className={cn(
                    'h-3 w-3 transition-transform duration-200 ease-out-quart',
                    infoOpen && 'rotate-90'
                  )}
                />
              </button>
            )}
            {backgroundTaskCount > 0 && (
              <span
                title={`${backgroundTaskCount} background subagent${backgroundTaskCount === 1 ? '' : 's'} running`}
                className="flex shrink-0 items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent"
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="tabular-nums">{backgroundTaskCount}</span>
              </span>
            )}
          </div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {activeLoop && (
            <button
              onClick={() => setLoopPaneOpen((o) => !o)}
              title="Loop settings"
              className={cn(
                'press-scale flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs',
                loopPaneOpen
                  ? 'bg-elevated text-text'
                  : 'text-text-muted hover:bg-white/5 hover:text-text'
              )}
            >
              <Settings className="h-3.5 w-3.5" /> Settings
            </button>
          )}
          <UsageMeter />
        </div>
      </header>

      {activeChat.kind === 'main' && infoOpen && <SessionInfo chat={activeChat} />}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            {activeLoop ? (
              <p className="max-w-xs text-sm text-text-muted">
                Loop <span className="font-medium text-text">{activeChat.title}</span> runs every{' '}
                {formatInterval(activeLoop.intervalMinutes)}. First heartbeat soon — or type to
                intervene.
              </p>
            ) : (
              <p className="text-sm text-text-muted"></p>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-4 py-4">
            {messages.length > visibleCount && (
              <p className="mb-3 text-center text-xs text-text-subtle">
                Scroll up to load older — showing the last {visibleCount} of {messages.length}
              </p>
            )}
            {messages.slice(-visibleCount).map((message) => (
              <MessageBubble key={message.id} role={message.role} parts={message.parts} />
            ))}
            {streaming !== null && <MessageBubble role="assistant" parts={streaming} streaming />}
          </div>
        )}
      </div>

      {queue.length > 0 && (
        <div className="bg-bg px-4 pt-2">
          <div className="mx-auto max-w-3xl">
            <Queue>
              <QueueSection defaultOpen>
                <QueueSectionTrigger>
                  <QueueSectionLabel
                    label="Queued"
                    count={queue.length}
                    icon={<ListTree className="h-3.5 w-3.5 text-text-subtle" />}
                  />
                  {sending && (
                    <span className="ml-auto text-[10px] text-text-subtle">
                      runs after this reply
                    </span>
                  )}
                </QueueSectionTrigger>
                <QueueSectionContent>
                  <QueueList>
                    {queue.map((item, i) => (
                      <QueuedMessage key={item.id} item={item} index={i} total={queue.length} />
                    ))}
                  </QueueList>
                </QueueSectionContent>
              </QueueSection>
            </Queue>
          </div>
        </div>
      )}

      <Composer onSend={submit} sending={sending} onStop={stop} />

      {loopPaneOpen && activeLoop && (
        <LoopDetailsPane
          loop={activeLoop}
          chat={activeChat}
          onClose={() => setLoopPaneOpen(false)}
        />
      )}
    </div>
  )
}
