import { useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronsUpDown, Search, Wrench } from 'lucide-react'
import { useRoxyStore } from '../lib/store'
import { ProviderLogo } from '../lib/providerLogos'
import { cn } from '../lib/cn'

/**
 * A cute, searchable model picker: the active provider's logo + model on the
 * trigger, and a popover grouped by every connected provider (with its icon)
 * listing the real models models.dev knows about, with reasoning/tools badges.
 */
export function ModelPicker(): JSX.Element {
  const providers = useRoxyStore((s) => s.providers)
  const settings = useRoxyStore((s) => s.settings)
  const selectModel = useRoxyStore((s) => s.selectModel)
  const models = useRoxyStore((s) => s.modelCatalog)
  const ensureModels = useRoxyStore((s) => s.ensureModels)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const activeProvider =
    providers.find((p) => p.id === settings?.activeProviderId) ?? providers[0] ?? null
  const activeModel = settings?.activeModel ?? null
  const loading = providers.some((p) => !models[p.id])

  // Lazy-load every connected provider's models into the shared catalog.
  useEffect(() => {
    providers.forEach((p) => void ensureModels(p.id))
  }, [providers, ensureModels])

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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text-muted transition hover:border-border-strong hover:text-text"
      >
        {activeProvider && <ProviderLogo id={activeProvider.id} name={activeProvider.name} size={14} />}
        <span className="max-w-[200px] truncate">{triggerLabel}</span>
        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-80 overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full bg-transparent text-xs text-text outline-none placeholder:text-text-subtle"
            />
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {loading && <div className="px-3 py-3 text-xs text-text-subtle">Loading models…</div>}
            {!loading &&
              providers.map((p) => {
                const list = (models[p.id] ?? []).filter(
                  (m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
                )
                if (list.length === 0) return null
                return (
                  <div key={p.id}>
                    <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-medium text-text-subtle">
                      <ProviderLogo id={p.id} name={p.name} size={13} /> {p.name}
                    </div>
                    {list.map((m) => {
                      const selected = p.id === activeProvider?.id && m.id === activeModel
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => pick(p.id, m.id)}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition',
                            selected
                              ? 'bg-accent/15 text-text'
                              : 'text-text-muted hover:bg-white/5 hover:text-text'
                          )}
                        >
                          <ProviderLogo id={p.id} name={p.name} size={14} />
                          <span className="min-w-0 flex-1 truncate">{m.name}</span>
                          {m.reasoning && <Brain className="h-3 w-3 shrink-0 text-accent" />}
                          {m.toolCall && <Wrench className="h-3 w-3 shrink-0 text-success" />}
                          {selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            {!loading && Object.values(models).every((l) => l.length === 0) && (
              <div className="px-3 py-3 text-xs text-text-subtle">
                Couldn&apos;t load models from models.dev — you can still send with the current model.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
