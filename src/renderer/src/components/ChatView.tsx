import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  CornerUpLeft,
  FolderOpen,
  Hammer,
  ListTree,
  Loader2,
  Repeat,
  RotateCw,
  Settings,
  Square
} from 'lucide-react'
import type { Chat } from '@shared/types'
import { useRoxyStore } from '../lib/store'
import { formatInterval } from '@shared/format'
import { cn } from '../lib/cn'
import { MessageBubble } from './MessageBubble'
import { Composer } from './Composer'
import { LoopDetailsPane } from './LoopDetailsPane'
import { SessionInfo } from './SessionInfo'
import { WorkstreamStrip } from './WorkstreamStrip'
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

/**
 * Render only the most recent N messages; scrolling near the top reveals PAGE
 * more. Older turns stay in the DB, they are just not in the DOM.
 *
 * This cap exists because a single message is not cheap: an agent turn can carry
 * dozens of tool cards, each with its own syntax-highlighted diff or terminal
 * output, and the whole transcript is markdown re-parsed by Streamdown on every
 * render. A few hundred of those is a visibly janky pane.
 *
 * 8 was too aggressive though — it is fewer turns than fit on a 1440p screen, so
 * an ordinary session showed the "showing the last 8 of N" notice while its own
 * content did not even fill the viewport, and any scroll up immediately paged.
 * 30 still bounds the worst case while covering essentially every session you
 * actually scroll through by hand.
 */
const VISIBLE_MESSAGES = 30
const PAGE = 30

export function ChatView(): JSX.Element {
  const messages = useRoxyStore((s) => s.messages)
  const messagesChatId = useRoxyStore((s) => s.messagesChatId)
  const messagesError = useRoxyStore((s) => s.messagesError)
  const streaming = useRoxyStore((s) =>
    s.activeChatId ? (s.streamingChats[s.activeChatId] ?? null) : null
  )
  const sending = useRoxyStore((s) => (s.activeChatId ? !!s.sendingChats[s.activeChatId] : false))
  const submit = useRoxyStore((s) => s.submit)
  const stop = useRoxyStore((s) => s.stop)
  const queue = useRoxyStore((s) => s.queue)
  const newSession = useRoxyStore((s) => s.newSession)
  const selectChat = useRoxyStore((s) => s.selectChat)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const chats = useRoxyStore((s) => s.chats)
  const loops = useRoxyStore((s) => s.loops)
  const backgroundTaskCount = useRoxyStore((s) =>
    s.activeChatId ? (s.runningTasks[s.activeChatId]?.length ?? 0) : 0
  )
  // A subagent working in ITS OWN session. Tracked separately from `sending`
  // (which is per-chat local-send state): nobody "sent" this turn from the UI —
  // the parent agent delegated it — so the only signal is the live run itself.
  const subagentRunning = useRoxyStore((s) =>
    s.activeChatId ? !!s.runningSubagents[s.activeChatId] : false
  )
  const cancelSubagent = useRoxyStore((s) => s.cancelSubagent)
  const cancelBackgroundTask = useRoxyStore((s) => s.cancelBackgroundTask)
  const runningTasks = useRoxyStore((s) =>
    s.activeChatId ? (s.runningTasks[s.activeChatId] ?? []) : []
  )

  const hasContent = messages.length > 0 || (streaming !== null && streaming.length > 0)
  // `messages` is cleared the instant you click a session and refilled only after
  // the round trip, so an empty array on its own says nothing about whether the
  // session HAS messages. Trusting it painted the empty state over every switch.
  const loading = !hasContent && !messagesError && messagesChatId !== activeChatId
  const isEmpty = !hasContent && !loading
  // The transcript has resolved one way or another (content, empty, or failed),
  // so the scroll effects below have something real to measure. Computed up here
  // rather than beside the JSX because the arrival pin depends on it.
  const transcriptReady = !loading

  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow the conversation only while you're already at the bottom. If you've
  // scrolled up to read history, new messages/stream chunks must NOT yank you
  // back down — resume following once you scroll back to the end.
  const stickToBottom = useRef(true)
  // The chat we have already jumped to the end of. Cleared on every switch, so
  // until it matches `activeChatId` the pane is still "arriving" and the tail
  // effect below owns the offset outright.
  const arrivedChatId = useRef<string | null>(null)
  // The last offset WE wrote. A scroll event replaying our own write must not be
  // mistaken for the user scrolling away (see `onScroll`).
  const pinnedTop = useRef(-1)
  const [loopPaneOpen, setLoopPaneOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  // Show only the latest N; scrolling up loads older ones a page at a time.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_MESSAGES)
  const restoreHeight = useRef<number | null>(null)
  // Which chat `restoreHeight` was measured in — a height from another session
  // is meaningless and must not be applied.
  const restoreChatId = useRef<string | null>(null)

  /** Jump to the newest message, recording the offset as ours. */
  const pinToBottom = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const top = el.scrollHeight - el.clientHeight
    pinnedTop.current = top
    el.scrollTop = top
  }, [])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    // Before the arrival pin lands, every scroll event here is our own doing:
    // the outgoing transcript unmounting collapses scrollHeight and the browser
    // clamps scrollTop to 0. Reading that back as "the user scrolled to the top"
    // is what left switches parked at the top — it cleared `stickToBottom` for a
    // session you had not even seen yet, so nothing ever pinned it, and at
    // scrollTop 0 it also paged in another 30 messages on the way past.
    if (arrivedChatId.current !== activeChatId) return
    // Landing exactly on the offset we last wrote counts as "still following"
    // even if the arithmetic below would say otherwise: the event is delivered a
    // beat after the write, and a turn that grew in between would look like a
    // gap the user had opened by hand. The ResizeObserver re-pins that growth.
    stickToBottom.current =
      el.scrollTop === pinnedTop.current || el.scrollHeight - el.scrollTop - el.clientHeight < 80
    // Near the top with more history → reveal another page, preserving position.
    if (el.scrollTop < 80 && visibleCount < messages.length) {
      restoreHeight.current = el.scrollHeight
      restoreChatId.current = activeChatId
      setVisibleCount((c) => Math.min(messages.length, c + PAGE))
    }
  }

  // Switching chats starts you pinned to the latest message + collapses details.
  //
  // This runs on LAYOUT and deliberately does NOT touch `scrollTop`. It used to
  // do both after paint (`useEffect` + `scrollTop = 0`), which is a race it lost
  // every time: the new transcript arrives a commit LATER than the switch, so
  // the reset ran after the tail effect had already pinned and stomped the pin
  // back to zero — and the scroll event that write produced then cleared
  // `stickToBottom`, so nothing pinned again. That is the whole "switching to a
  // session lands at the top" bug. Marking the session "not arrived" instead
  // hands the offset to the tail effect below, which lands it whenever the
  // content actually shows up, in whatever order the effects happen to run.
  useLayoutEffect(() => {
    stickToBottom.current = true
    arrivedChatId.current = null
    pinnedTop.current = -1
    // Drop any pending prepend-anchor: it holds the previous session's
    // scrollHeight, and applying that delta to the new one throws the offset
    // somewhere arbitrary.
    restoreHeight.current = null
    restoreChatId.current = null
    setInfoOpen(false)
    setVisibleCount(VISIBLE_MESSAGES)
  }, [activeChatId])

  // Keep the scroll anchored when older messages prepend (no jump to the top).
  // Guarded on the chat the measurement was taken in — `visibleCount` also
  // changes on a session switch, which would otherwise replay a stale delta.
  useEffect(() => {
    const el = scrollRef.current
    if (el && restoreHeight.current !== null && restoreChatId.current === activeChatId) {
      el.scrollTop += el.scrollHeight - restoreHeight.current
    }
    restoreHeight.current = null
    restoreChatId.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCount])

  // Follow the tail.
  //
  // Runs on layout (not after paint) so the jump is never a visible frame, and
  // re-pins on the next frame as well: a turn's content keeps growing AFTER this
  // commit — images decode, `lazy()` diff/file views resolve, Streamdown re-lays
  // out — and a single scrollTo lands short of the real bottom every time.
  //
  // The first pin after a switch is unconditional. `stickToBottom` cannot be
  // trusted yet at that point: the outgoing transcript unmounting fires a scroll
  // to 0 which, before this, was read as the user scrolling up.
  useLayoutEffect(() => {
    if (!scrollRef.current) return
    if (arrivedChatId.current !== activeChatId) {
      // Still waiting on this session's transcript — nothing to land on yet.
      // This effect re-runs when it arrives.
      if (!transcriptReady) return
      arrivedChatId.current = activeChatId
    } else if (!stickToBottom.current) return
    pinToBottom()
    const frame = requestAnimationFrame(() => {
      if (stickToBottom.current) pinToBottom()
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, streaming, activeChatId, transcriptReady, pinToBottom])

  // Content that settles late (a decoded screenshot is the common one) resizes
  // the column well after any frame we could schedule, so watch it rather than
  // guessing a delay.
  //
  // Attached by ref callback and kept for the column's lifetime. This used to be
  // built inside the tail effect above, whose deps include `streaming` — a fresh
  // array on EVERY streamed delta — so a live turn tore down and rebuilt a
  // ResizeObserver on each one, every rebuild firing an immediate observation
  // and forcing layout. That was a large share of the streaming jank.
  const resizeObserver = useRef<ResizeObserver | null>(null)
  const setContentNode = useCallback(
    (node: HTMLDivElement | null): void => {
      resizeObserver.current?.disconnect()
      resizeObserver.current = null
      if (!node) return
      const observer = new ResizeObserver(() => {
        if (stickToBottom.current) pinToBottom()
      })
      observer.observe(node)
      resizeObserver.current = observer
    },
    [pinToBottom]
  )
  useEffect(() => () => resizeObserver.current?.disconnect(), [])

  // Re-pin when the SCROLLPORT resizes, not just its content.
  //
  // Everything stacked below the transcript takes its height out of this pane's
  // `flex-1`: the queue appearing, expanding or collapsing, the composer
  // auto-growing as you type, the workstream strip. The browser does not adjust
  // `scrollTop` for that, and both directions are visibly wrong:
  //
  //   shrinking (queue opens) — the max scroll offset grows, so an offset that
  //     WAS the bottom is now short of it and the last messages slide out of
  //     view. Reads as the queue shoving the transcript upward.
  //   growing (queue collapses) — the reclaimed height appears BELOW the last
  //     message as dead space, because the offset never moves back down. Reads
  //     as the collapsed queue still holding its space.
  //
  // Kept separate from the effect above on purpose: this one is installed once
  // and must keep observing across queue toggles, which change neither
  // `messages` nor `streaming` and so would never re-run that effect.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const activeChat = chats.find((c) => c.id === activeChatId)
  const isSub = activeChat?.kind === 'sub'
  const parentChat = activeChat?.parentId
    ? chats.find((c) => c.id === activeChat.parentId)
    : undefined
  const activeLoop = loops.find((l) => l.chatId === activeChatId)
  const sessionTasks = activeChat?.tasks ?? []
  const tasksDone = sessionTasks.filter((t) => t.status === 'completed').length
  // Any session can carry a description + checklist: the `general` subagent has
  // the metadata tool too, and its plan is exactly what you open its session to
  // read. Gate on having something to show, not on the session's kind.
  const hasSessionInfo = !!activeChat?.description?.trim() || sessionTasks.length > 0

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
            {isSub ? (
              <Hammer className="h-4 w-4 shrink-0 text-text-muted" />
            ) : (
              <FolderOpen className="h-4 w-4 shrink-0 text-text-muted" />
            )}
            <span className="shrink-0 text-sm font-medium">{activeChat.title}</span>
            {/* A delegate's session is only legible in context — who sent it, and
                a way back. The folder path is the parent's business. */}
            {isSub ? (
              parentChat && (
                <button
                  onClick={() => void selectChat(parentChat.id)}
                  title={`Back to ${parentChat.title}`}
                  className="flex min-w-0 items-center gap-1 truncate text-xs text-text-subtle transition-colors hover:text-text"
                >
                  <CornerUpLeft className="h-3 w-3 shrink-0" />
                  <span className="truncate">{parentChat.title}</span>
                </button>
              )
            ) : (
              <WorkspacePath chat={activeChat} />
            )}
            {subagentRunning && activeChatId && (
              // Clickable, because this used to be the one running thing in the
              // app with no way to stop it: a subagent's turn is driven by its
              // parent, so the composer's Stop was deliberately withheld here
              // (it had no request of its own to abort) and the session was
              // simply uninterruptible from its own view.
              <button
                onClick={() => void cancelSubagent(activeChatId)}
                title="Cancel this subagent"
                className="press-scale group flex shrink-0 items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/20"
              >
                <Loader2 className="h-3 w-3 animate-spin group-hover:hidden" />
                <Square className="hidden h-2.5 w-2.5 fill-current group-hover:block" />
                <span className="group-hover:hidden">working</span>
                <span className="hidden group-hover:inline">cancel</span>
              </button>
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
            {backgroundTaskCount > 0 && activeChatId && (
              // Detached tasks were cancellable in main from day one
              // (`tasks:cancel`) but nothing ever called it — this badge counted
              // them and offered no way out. Cancels them all: they're detached
              // by definition, so "stop the thing I didn't ask for" is the whole
              // interaction, and per-task control lives on the task card.
              <button
                onClick={() => {
                  for (const t of runningTasks) void cancelBackgroundTask(activeChatId, t.jobId)
                }}
                title={`Cancel ${backgroundTaskCount} background subagent${
                  backgroundTaskCount === 1 ? '' : 's'
                }`}
                className="press-scale group flex shrink-0 items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/20"
              >
                <Loader2 className="h-3 w-3 animate-spin group-hover:hidden" />
                <Square className="hidden h-2.5 w-2.5 fill-current group-hover:block" />
                <span className="tabular-nums">{backgroundTaskCount}</span>
              </button>
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

      {infoOpen && <SessionInfo chat={activeChat} />}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        // overflow-anchor is off because this pane does its own scroll math:
        // paging in older messages measures scrollHeight and re-applies the
        // delta by hand. Chromium's anchoring would apply its own correction on
        // top of that, and the two together overshoot.
        style={{ overflowAnchor: 'none' }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {messagesError ? (
          // A failed load used to be indistinguishable from an empty session:
          // silent, blank, and with no way back other than clicking away and
          // returning. Name it and make it recoverable.
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="max-w-xs text-sm text-text-muted">
              Couldn&apos;t load this session&apos;s messages.
            </p>
            <Button variant="ghost" onClick={() => void selectChat(activeChat.id)}>
              <RotateCw className="h-4 w-4" /> Retry
            </Button>
          </div>
        ) : loading ? (
          // Deliberately blank: a transcript read is a local SQLite query, so it
          // resolves within a frame or two and a spinner would be a flash of
          // chrome rather than information. This branch exists to stop the EMPTY
          // state (and its loop copy) from claiming the session has no messages
          // before we know that.
          <div className="h-full" />
        ) : isEmpty ? (
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
          // mt-auto bottom-aligns a SHORT transcript.
          //
          // A new or brief session does not fill the pane, and a top-aligned
          // column left everything below the last message as empty background --
          // measured at 488px on a two-message session, which reads as a broken
          // layout rather than breathing room. Pinning to the bottom cannot fix
          // it: with nothing to scroll, scrollTop is already 0.
          //
          // mt-auto absorbs that slack while the column is shorter than the
          // scrollport and resolves to 0 the moment it overflows, so long
          // transcripts are untouched. Deliberately NOT justify-end on the
          // parent: that clips overflow at the TOP in Chromium, which would put
          // paged-in history out of reach. w-full because a flex child would
          // otherwise shrink-to-fit and mx-auto would no longer center it.
          //
          // pb clears the fade below: at max scroll the last line has to end
          // ABOVE the gradient, otherwise the final message always looks dimmed.
          <div ref={setContentNode} className="mx-auto mt-auto w-full max-w-3xl px-4 pb-6 pt-4">
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

      {/* The transcript used to end on a hard clip: the scrollport edge sliced
          text mid-glyph, straight into the composer’s flat gutter, and the two
          together read as a black bar cutting the pane in half. This is a
          gradient of the pane’s own background laid over the last 24px of the
          scroller, so lines dissolve into the composer instead of being cut.

          Pulled back up by its own height (-mt-6) so it costs no layout — the
          scroller keeps every pixel of flex-1 — and inert to the pointer, so
          scrolling and text selection still work underneath it. The matching
          pb-6 on the message column is what keeps the last line legible: at
          max scroll it ends above the gradient instead of under it.

          The mr-2.5 is the scrollbar gutter (10px, see ::-webkit-scrollbar
          in main.css). The bar occupies the scroller’s right edge, so a
          full-width fade would paint over its last 24px and wash out the
          thumb exactly when you drag it to the end. */}
      <div
        aria-hidden
        className="pointer-events-none relative z-10 -mt-6 mr-2.5 h-6 shrink-0 bg-gradient-to-b from-transparent to-bg"
      />

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

      {/* A subagent's session can now be stopped from its own composer: the Stop
          cancels the DELEGATE (there is no local request here to abort), which
          is what the button visibly means in this view. */}
      <Composer
        onSend={submit}
        sending={sending || subagentRunning}
        onStop={subagentRunning && activeChatId ? () => void cancelSubagent(activeChatId) : stop}
      />

      <WorkstreamStrip />

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

/**
 * The folder this session's agent actually runs in, click to copy.
 *
 * Shows `worktreePath` in preference to `workspacePath`. Those differ for every
 * workstream: the project folder is the repo you opened, but the agent's cwd is
 * an isolated checkout under `worktrees/`. Showing the project path meant the
 * header named a directory the session was NOT editing — actively misleading
 * when several workstreams are open and you are trying to work out which
 * checkout a dev server or an editor tab belongs to.
 *
 * Copying is the point: these paths are long, truncated by the header, and
 * mostly wanted for pasting into a terminal. Selecting truncated text by hand
 * is fiddly, so the whole thing is one click.
 */
function WorkspacePath({ chat }: { chat: Chat }): JSX.Element | null {
  const path = chat.worktreePath ?? chat.workspacePath
  const [copied, setCopied] = useState(0)

  // Keyed on the click COUNT, not a boolean: clicking again while the
  // confirmation is still up restarts the window, instead of the first click's
  // timer cutting the second one short.
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(0), 1200)
    return () => clearTimeout(t)
  }, [copied])

  if (!path) return null

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      setCopied((n) => n + 1)
    } catch {
      // Clipboard can be denied; the path stays readable in the tooltip.
    }
  }

  return (
    <button
      onClick={() => void copy()}
      // The label is truncated, so the tooltip carries the full path.
      title={`${path}\nClick to copy`}
      className="press-scale relative flex min-w-0 items-center rounded-md px-1 py-0.5 text-xs text-text-subtle hover:bg-white/5 hover:text-text-muted"
    >
      {/* The path fades rather than unmounting, so the button keeps its width
          and nothing in the header shifts while the confirmation shows. */}
      <span
        className={cn(
          'truncate transition-opacity duration-150 ease-out-quart',
          copied && 'opacity-0'
        )}
      >
        {path}
      </span>
      {/* Confirmation sits ON TOP of the path, left-aligned to it, so it reads
          as the same object changing state. Fires often enough that a moving
          toast would be noise -- this is the smallest thing that still answers
          "did that work?". */}
      <span
        aria-live="polite"
        className={cn(
          'absolute inset-y-0 left-1 flex items-center gap-1 text-success transition-[opacity,transform] duration-150 ease-out-quart',
          copied ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-0.5 opacity-0'
        )}
      >
        <Check className="h-3 w-3 shrink-0" />
        Copied
      </span>
    </button>
  )
}
