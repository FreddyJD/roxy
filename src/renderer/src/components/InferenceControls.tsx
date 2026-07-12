import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, Check, Loader2 } from 'lucide-react'
import type { MessagePart, ReasoningEffort } from '@shared/types'
import type { ModelInfo } from '@shared/api'
import { PRIMARY_AGENTS, getAgent, DEFAULT_AGENT_ID } from '@shared/agents'
import { buildSystemPrompt, useRoxyStore } from '../lib/store'
import { cn } from '../lib/cn'

/** Close-on-outside-click / Escape for a small popover. */
function usePopover(): {
  open: boolean
  setOpen: (v: boolean) => void
  ref: React.RefObject<HTMLDivElement>
} {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref }
}

/** Resolve the active model's capabilities (reasoning + context window). */
function useActiveModelInfo(): ModelInfo | undefined {
  const providers = useRoxyStore((s) => s.providers)
  const settings = useRoxyStore((s) => s.settings)
  const modelCatalog = useRoxyStore((s) => s.modelCatalog)
  const ensureModels = useRoxyStore((s) => s.ensureModels)
  const activeProvider =
    providers.find((p) => p.id === settings?.activeProviderId) ?? providers[0] ?? null
  const activeModel = settings?.activeModel ?? null
  useEffect(() => {
    if (activeProvider) void ensureModels(activeProvider.id)
  }, [activeProvider, ensureModels])
  if (!activeProvider || !activeModel) return undefined
  return modelCatalog[activeProvider.id]?.find((m) => m.id === activeModel)
}

const triggerClass =
  'press-scale flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text-muted hover:border-border-strong hover:text-text'
const popoverClass =
  'animate-pop-in absolute bottom-full left-0 z-50 mb-2 w-72 origin-bottom-left overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl'

// ---- Thinking effort ---------------------------------------------------------

const EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Xhigh' },
  { value: 'max', label: 'Max' }
]

export function ThinkingPicker(): JSX.Element | null {
  const info = useActiveModelInfo()
  const settings = useRoxyStore((s) => s.settings)
  const setReasoningEffort = useRoxyStore((s) => s.setReasoningEffort)
  const { open, setOpen, ref } = usePopover()

  if (!info?.reasoning) return null
  const current = settings?.reasoningEffort ?? 'high'
  const currentLabel = EFFORTS.find((e) => e.value === current)?.label ?? 'High'

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className={triggerClass} title="Thinking effort">
        <Brain className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span>{currentLabel}</span>
      </button>
      {open && (
        <div className={popoverClass}>
          <div className="border-b border-border px-3 py-2 text-[11px] font-medium text-text-subtle">
            Thinking Effort
          </div>
          <div className="py-1">
            {EFFORTS.map((e) => {
              const selected = e.value === current
              return (
                <button
                  key={e.value}
                  type="button"
                  onClick={() => {
                    void setReasoningEffort(e.value)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition',
                    selected ? 'bg-accent/15' : 'hover:bg-white/5'
                  )}
                >
                  <Check
                    className={cn('h-3.5 w-3.5 shrink-0', selected ? 'text-accent' : 'opacity-0')}
                  />
                  <span className="text-xs font-medium text-text">{e.label}</span>
                  <span className="ml-auto text-[11px] text-text-subtle">
                    {e.value === 'high' ? 'Default' : ''}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-text-subtle">
            Higher levels of thinking may increase cost.
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Agent (Build vs Plan) ---------------------------------------------------

/**
 * Primary-agent selector. Switching to Plan makes the next turn read-only: the
 * harness resolves this agent id, layers its `plan.txt` reminder onto the system
 * prompt, and narrows the tool allowlist (no write/edit). Build is the default.
 */
export function AgentPicker(): JSX.Element {
  const activeAgentId = useRoxyStore((s) => s.activeAgentId)
  const setActiveAgent = useRoxyStore((s) => s.setActiveAgent)
  const { open, setOpen, ref } = usePopover()

  const active = getAgent(activeAgentId) ?? getAgent(DEFAULT_AGENT_ID)!

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className={triggerClass} title="Agent mode">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: active.color }}
        />
        <span>{active.name}</span>
      </button>
      {open && (
        <div className={popoverClass}>
          <div className="border-b border-border px-3 py-2 text-[11px] font-medium text-text-subtle">
            Agent
          </div>
          <div className="py-1">
            {PRIMARY_AGENTS.map((a) => {
              const selected = a.id === active.id
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setActiveAgent(a.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-1.5 text-left transition',
                    selected ? 'bg-accent/15' : 'hover:bg-white/5'
                  )}
                >
                  <Check
                    className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', selected ? 'text-accent' : 'opacity-0')}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-text">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: a.color }}
                      />
                      {a.name}
                      {a.id === DEFAULT_AGENT_ID && (
                        <span className="text-text-subtle">(default)</span>
                      )}
                    </span>
                    <span className="block text-[11px] text-text-subtle">{a.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-text-subtle">
            Plan is read-only — it explores and proposes without editing files.
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Context window ----------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0))}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/** Sensible context stops ≤ the model's max, always including the true max. */
function contextOptions(max: number): number[] {
  const stops = [32_000, 64_000, 128_000, 200_000, 400_000, 1_000_000, 2_000_000]
  const opts = stops.filter((s) => s < max)
  opts.push(max)
  return Array.from(new Set(opts))
}

/**
 * The window the model can actually use. models.dev reports Claude's *base*
 * 200K, but the model (and VS Code's Copilot client) expose a 1M window —
 * Anthropic via the `context-1m` beta, Copilot server-side. Raise the ceiling
 * for these large reasoning models so the picker matches what they can do.
 */
function effectiveContextMax(info: ModelInfo): number {
  const base = info.contextLimit ?? 0
  if (info.reasoning && base >= 180_000 && base <= 264_000) return 1_000_000
  return base
}

export function ContextPicker(): JSX.Element | null {
  const info = useActiveModelInfo()
  const settings = useRoxyStore((s) => s.settings)
  const setContextLimit = useRoxyStore((s) => s.setContextLimit)
  const { open, setOpen, ref } = usePopover()

  const max = info ? effectiveContextMax(info) : 0
  if (!max) return null
  const options = contextOptions(max)
  const defaultBudget = Math.min(max, 200_000)
  const current = settings?.contextLimit ?? defaultBudget

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className={triggerClass} title="Context window">
        <span>{formatTokens(current)}</span>
      </button>
      {open && (
        <div className={popoverClass}>
          <div className="border-b border-border px-3 py-2 text-[11px] font-medium text-text-subtle">
            Context Size
          </div>
          <div className="py-1">
            {options.map((value) => {
              const selected = value === current
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    void setContextLimit(value)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition',
                    selected ? 'bg-accent/15' : 'hover:bg-white/5'
                  )}
                >
                  <Check
                    className={cn('h-3.5 w-3.5 shrink-0', selected ? 'text-accent' : 'opacity-0')}
                  />
                  <span className="text-xs font-medium text-text">{formatTokens(value)}</span>
                  <span className="ml-auto text-[11px] text-text-subtle">
                    {value === defaultBudget
                      ? 'Default'
                      : value === max
                        ? 'Longer sessions without compaction'
                        : ''}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-text-subtle">
            Larger context may increase cost.
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Context usage meter -----------------------------------------------------

interface Category {
  label: string
  tokens: number
}

/**
 * VS Code-style context meter: a slim used/total bar that, on hover, opens a
 * categorized breakdown (system instructions, tool definitions, messages, tool
 * results, other) with a reserved-for-response segment + a Compact button.
 */
export function ContextMeter(): JSX.Element {
  const info = useActiveModelInfo()
  const settings = useRoxyStore((s) => s.settings)
  const messages = useRoxyStore((s) => s.messages)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const streaming = useRoxyStore((s) =>
    s.activeChatId ? s.streamingChats[s.activeChatId] : undefined
  )
  const chats = useRoxyStore((s) => s.chats)
  const activeAgentId = useRoxyStore((s) => s.activeAgentId)
  const projectInstructions = useRoxyStore((s) => s.projectInstructions)
  const ensureProjectInstructions = useRoxyStore((s) => s.ensureProjectInstructions)
  const compactConversation = useRoxyStore((s) => s.compactConversation)
  const compacting = useRoxyStore((s) => (activeChatId ? !!s.compactingChats[activeChatId] : false))
  const [open, setOpen] = useState(false)

  const chat = chats.find((c) => c.id === activeChatId)
  // Load the workspace's instruction files so systemTokens counts them; the
  // subscription above re-renders the meter once they resolve.
  useEffect(() => {
    if (chat?.workspacePath) void ensureProjectInstructions(chat.workspacePath)
  }, [chat?.workspacePath, ensureProjectInstructions])
  const since = chat?.contextSummaryAt ?? 0
  // Count only what actually goes to the model: turns after the compaction point.
  const counted = messages.filter((m) => m.createdAt > since)

  let messagesTokens = 0
  let toolTokens = 0
  let otherTokens = 0
  const countPart = (p: MessagePart): void => {
    if (p.type === 'text' || p.type === 'reasoning') messagesTokens += Math.ceil(p.text.length / 4)
    else if (p.type === 'tool') toolTokens += Math.ceil((p.output?.length ?? 0) / 4)
    else if (p.type === 'image') otherTokens += 800
  }
  for (const m of counted) for (const p of m.parts) countPart(p)
  // Fold in the in-flight assistant turn so the meter fills live as the agent's
  // text, reasoning, and tool results stream in — not only after the turn ends.
  if (streaming) for (const p of streaming) countPart(p)
  // Recomputes when the workspace's instructions resolve (projectInstructions dep),
  // so the meter reflects AGENTS.md/CLAUDE.md size once loaded.
  const systemTokens = useMemo(
    () => Math.ceil(buildSystemPrompt(chat, info?.id, activeAgentId).length / 4),
    [chat, info?.id, activeAgentId, projectInstructions]
  )
  const toolDefsTokens = chat?.workspacePath ? 1100 : 0
  const used = messagesTokens + toolTokens + otherTokens + systemTokens + toolDefsTokens

  const modelCtx = info ? effectiveContextMax(info) : undefined
  const total = modelCtx
    ? Math.min(settings?.contextLimit ?? Math.min(modelCtx, 200_000), modelCtx)
    : null
  const reserve = total ? Math.min(info?.outputLimit ?? 4096, Math.round(total * 0.25)) : 0
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0
  const reservePct = total ? Math.min(100 - pct, Math.round((reserve / total) * 100)) : 0
  const fmtShare = (t: number): string =>
    total ? `${((t / total) * 100).toFixed(1)}%` : formatTokens(t)

  const groups: { group: string; items: Category[] }[] = [
    {
      group: 'System',
      items: [
        { label: 'System Instructions', tokens: systemTokens },
        ...(toolDefsTokens ? [{ label: 'Tool Definitions', tokens: toolDefsTokens }] : [])
      ]
    },
    {
      group: 'User Context',
      items: [
        { label: 'Messages', tokens: messagesTokens },
        ...(toolTokens ? [{ label: 'Tool Results', tokens: toolTokens }] : [])
      ]
    },
    ...(otherTokens
      ? [{ group: 'Uncategorized', items: [{ label: 'Other', tokens: otherTokens }] }]
      : [])
  ]

  const hatch =
    'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.16) 2px, rgba(255,255,255,0.16) 4px)'

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {open && (
        <div className="absolute bottom-full left-0 z-50 w-72 pb-1.5">
          <div className="animate-pop-in origin-bottom-left overflow-hidden rounded-xl border border-border bg-elevated p-3 shadow-2xl">
          <div className="mb-1.5 text-xs font-medium text-text">Context Window</div>
          <div className="mb-1 flex items-baseline justify-between text-[11px] text-text-subtle">
            <span className="tabular-nums">
              {formatTokens(used)} {total ? `/ ${formatTokens(total)}` : ''} tokens
            </span>
            {total ? <span className="tabular-nums">{pct}%</span> : null}
          </div>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <span
              className={cn('h-full', pct >= 90 ? 'bg-danger' : 'bg-accent')}
              style={{ width: `${pct}%` }}
            />
            <span className="h-full bg-accent/30" style={{ width: `${reservePct}%`, backgroundImage: hatch }} />
          </div>
          {reserve > 0 && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-subtle">
              <span className="h-2.5 w-2.5 rounded-sm bg-accent/30" style={{ backgroundImage: hatch }} />
              Reserved for response
            </div>
          )}

          {groups.map((g) => (
            <div key={g.group} className="mt-2.5">
              <div className="mb-0.5 text-[11px] font-medium text-text-muted">{g.group}</div>
              {g.items.map((it) => (
                <div
                  key={it.label}
                  className="flex items-center justify-between py-0.5 text-[11px] text-text-subtle"
                >
                  <span>{it.label}</span>
                  <span className="tabular-nums">{fmtShare(it.tokens)}</span>
                </div>
              ))}
            </div>
          ))}

          {total && pct >= 75 && (
            <div className="mt-2 text-[11px] text-danger/90">Quality may decline as limit nears.</div>
          )}

          <button
            type="button"
            onClick={() => void compactConversation()}
            disabled={compacting || counted.length === 0}
            className="press-scale mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs text-text hover:border-border-strong hover:bg-elevated disabled:opacity-40"
          >
            {compacting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Compacting…
              </>
            ) : (
              'Compact Conversation'
            )}
          </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text-muted transition-colors hover:border-border-strong hover:text-text">
        {total ? (
          <>
            <span className="h-1 w-8 overflow-hidden rounded-full bg-surface-2">
              <span
                className={cn('block h-full rounded-full', pct >= 90 ? 'bg-danger' : 'bg-accent/70')}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="tabular-nums">{pct}%</span>
          </>
        ) : (
          <span className="tabular-nums">{formatTokens(used)}</span>
        )}
      </div>
    </div>
  )
}
