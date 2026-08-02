import { useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronsUpDown, Clock, Search, Wrench } from 'lucide-react'
import { useRoxyStore } from '../lib/store'
import { resolveSessionConfig } from '@shared/session-config'
import { ProviderLogo } from '../lib/providerLogos'
import { triggerClass } from './InferenceControls'
import { useMenuAnchor } from '../lib/useMenuAnchor'
import { cn } from '../lib/cn'

/**
 * A cute, searchable model picker: the active provider's logo + model on the
 * trigger, and a popover grouped by every connected provider (with its icon)
 * listing the real models models.dev knows about. A LATEST section shows the
 * last five distinct picks for each provider.
 */
const MENU_W = 320

export function ModelPicker(): JSX.Element {
  const providers = useRoxyStore((s) => s.providers)
  const settings = useRoxyStore((s) => s.settings)
  const chats = useRoxyStore((s) => s.chats)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const selectModel = useRoxyStore((s) => s.selectModel)
  const models = useRoxyStore((s) => s.modelCatalog)
  const recentModels = useRoxyStore((s) => s.recentModels)
  const ensureModels = useRoxyStore((s) => s.ensureModels)
  const ensureRecentModels = useRoxyStore((s) => s.ensureRecentModels)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  // Leftmost control, so it only clips in a narrow window — but it clips the
  // same way, and one rule for all of them beats a special case.
  const anchor = useMenuAnchor(rootRef, open, MENU_W, { gap: 8 })

  // The model shown is the OPEN SESSION's, not a global one: two sessions can
  // sit on different models at once, and each remembers its own across
  // restarts. A session with nothing pinned falls back to the last-used pair.
  const config = resolveSessionConfig(
    chats.find((c) => c.id === activeChatId),
    settings
  )
  const activeProvider = providers.find((p) => p.id === config.providerId) ?? providers[0] ?? null
  // Only show the session's model when it belongs to the provider we resolved.
  // A session pinned to a provider that was since disconnected falls back to
  // another one, and labelling that fallback with the old model would claim a
  // pairing the turn will not actually use (the send path picks the fallback
  // provider's own default instead).
  const activeModel = activeProvider?.id === config.providerId ? config.model : null
  const loading = providers.some((p) => !models[p.id])

  // Lazy-load every connected provider's models and recents into shared caches.
  useEffect(() => {
    providers.forEach((p) => {
      void ensureModels(p.id)
      void ensureRecentModels(p.id)
    })
  }, [providers, ensureModels, ensureRecentModels])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
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

  if (providers.length === 0) {
    return <span className="px-1 text-xs text-text-subtle">No provider connected</span>
  }

  const q = query.trim().toLowerCase()
  const triggerLabel = ((): string => {
    if (!activeModel) return 'Select a model'
    const found = activeProvider && models[activeProvider.id]?.find((m) => m.id === activeModel)
    return found ? found.name : activeModel
  })()

  const pick = async (providerId: string, modelId: string): Promise<void> => {
    await selectModel(providerId, modelId)
    setOpen(false)
    setQuery('')
  }

  const modelName = (providerId: string, modelId: string): string =>
    models[providerId]?.find((m) => m.id === modelId)?.name ?? modelId

  const renderModelButton = (
    providerId: string,
    providerName: string,
    modelId: string,
    label = modelName(providerId, modelId)
  ): JSX.Element => {
    const info = models[providerId]?.find((m) => m.id === modelId)
    const selected = providerId === activeProvider?.id && modelId === activeModel
    return (
      <button
        key={modelId}
        type="button"
        onClick={() => pick(providerId, modelId)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition',
          selected ? 'bg-accent/15 text-text' : 'text-text-muted hover:bg-white/5 hover:text-text'
        )}
      >
        <ProviderLogo id={providerId} name={providerName} size={14} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {info?.reasoning && <Brain className="h-3 w-3 shrink-0 text-accent" />}
        {info?.toolCall && <Wrench className="h-3 w-3 shrink-0 text-success" />}
        {selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
      </button>
    )
  }

  return (
    <div ref={rootRef} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={triggerClass}>
        {activeProvider && (
          <ProviderLogo id={activeProvider.id} name={activeProvider.name} size={14} />
        )}
        <span className="max-w-[200px] truncate">{triggerLabel}</span>
        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          className="animate-pop-in absolute bottom-full z-50 mb-2 flex flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl origin-bottom-left"
          style={anchor}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full bg-transparent text-xs text-text outline-none placeholder:text-text-subtle"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {loading && <div className="px-3 py-3 text-xs text-text-subtle">Loading models…</div>}
            {!loading &&
              providers.map((p) => {
                const list = (models[p.id] ?? []).filter(
                  (m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
                )
                const latest = q ? [] : (recentModels[p.id] ?? [])
                if (list.length === 0 && latest.length === 0) return null
                return (
                  <div key={p.id}>
                    {latest.length > 0 && (
                      <>
                        <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-text-subtle">
                          <Clock className="h-3 w-3" /> Latest · {p.name}
                        </div>
                        {latest.map((r) => renderModelButton(p.id, p.name, r.model))}
                      </>
                    )}
                    {list.length > 0 && (
                      <>
                        <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-medium text-text-subtle">
                          <ProviderLogo id={p.id} name={p.name} size={13} /> {p.name}
                        </div>
                        {list.map((m) => renderModelButton(p.id, p.name, m.id, m.name))}
                      </>
                    )}
                  </div>
                )
              })}
            {!loading && Object.values(models).every((l) => l.length === 0) && (
              <div className="px-3 py-3 text-xs text-text-subtle">
                Couldn&apos;t load models from models.dev — you can still send with the current
                model.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
