import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, Search, X } from 'lucide-react'
import type { BrowserState, BrowserTab } from '@shared/api'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

const BLANK: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false
}

/**
 * The Roxy browser's chrome — a real React tab strip + URL bar (themed to match
 * the app), rendered into the browser window's top BrowserView. It talks to the
 * main process purely through `window.roxy.browser.*`; the agent still drives
 * the active tab from main, and this just reflects/controls it.
 */
export function BrowserChrome(): JSX.Element {
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [nav, setNav] = useState<BrowserState>(BLANK)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)

  useEffect(() => {
    const offState = api.browser.onState(setNav)
    const offTabs = api.browser.onTabs(setTabs)
    return () => {
      offState()
      offTabs()
    }
  }, [])

  // Mirror the live URL into the input unless the user is editing it.
  useEffect(() => {
    if (!editing) setDraft(nav.url && nav.url !== 'about:blank' ? nav.url : '')
  }, [nav.url, editing])

  const go = (): void => {
    void api.browser.navigate(draft)
    setEditing(false)
  }

  const reloadOrStop = (): void => {
    if (nav.loading) void api.browser.stop()
    else void api.browser.reload()
  }

  const secure = nav.url.startsWith('https://')

  return (
    <div className="flex h-screen w-screen select-none flex-col overflow-hidden bg-surface text-text">
      {/* Tab strip — doubles as the draggable title bar; native controls overlay it. */}
      <div className="titlebar reserve-controls-left reserve-controls-right flex items-end gap-0.5 overflow-x-auto px-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <div
            key={t.id}
            draggable
            onClick={() => void api.browser.activateTab(t.id)}
            onDragStart={(e) => {
              setDragId(t.id)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', t.id)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId && dragId !== t.id) {
                void api.browser.moveTab(
                  dragId,
                  tabs.findIndex((x) => x.id === t.id)
                )
              }
              setDragId(null)
            }}
            onDragEnd={() => setDragId(null)}
            title={t.url}
            className={cn(
              'group relative flex h-7 min-w-[120px] max-w-[220px] shrink-0 cursor-default items-center gap-2 rounded-t-lg px-3 text-xs transition-colors [-webkit-app-region:no-drag]',
              dragId === t.id && 'opacity-50',
              t.active
                ? 'bg-elevated text-text'
                : 'bg-surface-2/50 text-text-muted hover:bg-surface-2 hover:text-text'
            )}
          >
            <Globe className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
            <span className="min-w-0 flex-1 truncate">{t.title || 'New tab'}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void api.browser.closeTab(t.id)
              }}
              title="Close tab"
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-text-subtle transition-colors hover:bg-border-strong hover:text-text',
                t.active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => void api.browser.newTab()}
          title="New tab"
          className="press-scale mb-0.5 ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface-2 hover:text-text"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* Nav + URL bar */}
      <div className="flex items-center gap-1 border-b border-border px-2.5 pb-2 pt-1">
        <NavButton onClick={() => void api.browser.back()} disabled={!nav.canGoBack} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </NavButton>
        <NavButton
          onClick={() => void api.browser.forward()}
          disabled={!nav.canGoForward}
          title="Forward"
        >
          <ArrowRight className="h-4 w-4" />
        </NavButton>
        <NavButton onClick={reloadOrStop} title={nav.loading ? 'Stop' : 'Reload'}>
          {nav.loading ? <X className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
        </NavButton>
        <div className="relative ml-1 flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle">
            {!draft ? (
              <Search className="h-3.5 w-3.5" />
            ) : (
              <Globe className={cn('h-3.5 w-3.5', secure && 'text-success')} />
            )}
          </span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go()
            }}
            placeholder="Search or enter a URL"
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-full rounded-full border border-border bg-surface-2 pl-9 pr-3.5 text-xs text-text outline-none transition-colors placeholder:text-text-subtle focus:border-accent focus:bg-surface focus:ring-1 focus:ring-accent/35"
          />
        </div>
      </div>
    </div>
  )
}

function NavButton({
  children,
  onClick,
  disabled,
  title
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="press-scale flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-text-muted"
    >
      {children}
    </button>
  )
}
