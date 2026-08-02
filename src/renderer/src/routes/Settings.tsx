import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GripVertical, Globe, Plus, Trash2 } from 'lucide-react'
import type { AppVersions, ConnectedProvider } from '@shared/types'
import type { UpdateInfo } from '@shared/api'
import { AUTH_LABELS } from '@shared/providers'
import { api } from '../lib/api'
import { CodeHosts } from '../components/CodeHosts'
import { Button, Switch } from '../components/ui'
import { cn } from '../lib/cn'
import {
  DEFAULT_BRANCH_PREFIX,
  branchPrefixError,
  normalizeBranchPrefix,
  placeholderBranchName
} from '@shared/branch'
import { randomSlug, slugToBranchSegment } from '@shared/slugs'
import { PageShell } from '../components/PageShell'
import { McpServers } from '../components/McpServers'
import { ConfigBackup } from '../components/ConfigBackup'
import { ActivitySection } from '../components/ActivitySection'
import { ProviderLogo } from '../lib/providerLogos'
import { CodexAccounts } from '../components/CodexSetup'
import { useRoxyStore } from '../lib/store'

export default function Settings(): JSX.Element {
  const navigate = useNavigate()
  const providers = useRoxyStore((s) => s.providers)
  const settings = useRoxyStore((s) => s.settings)
  const refreshProviders = useRoxyStore((s) => s.refreshProviders)
  const reorderProviders = useRoxyStore((s) => s.reorderProviders)
  const setWebSearchApiKey = useRoxyStore((s) => s.setWebSearchApiKey)
  const setAutoWorkstream = useRoxyStore((s) => s.setAutoWorkstream)
  const setBranchPrefix = useRoxyStore((s) => s.setBranchPrefix)
  const [prefix, setPrefix] = useState('')
  const prefixError = branchPrefixError(prefix)
  // Pinned once per mount: a preview that reshuffled on every keystroke
  // would read as noise rather than as an example.
  const [example] = useState(() => slugToBranchSegment(randomSlug()))
  const bootstrap = useRoxyStore((s) => s.bootstrap)
  const clearActive = useRoxyStore((s) => s.clearActive)
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [searchKey, setSearchKey] = useState('')
  const [searchKeySaved, setSearchKeySaved] = useState(false)
  const [dragProviderId, setDragProviderId] = useState<string | null>(null)
  const [dragOverProviderId, setDragOverProviderId] = useState<string | null>(null)
  const [dropAfterProvider, setDropAfterProvider] = useState(false)

  const reorderWithinProviders = (
    sourceId: string,
    targetId: string,
    place: 'before' | 'after'
  ): string[] | null => {
    const ids = providers.map((p) => p.id)
    const from = ids.indexOf(sourceId)
    if (from === -1 || ids.indexOf(targetId) === -1) return null
    ids.splice(from, 1)
    ids.splice(ids.indexOf(targetId) + (place === 'after' ? 1 : 0), 0, sourceId)
    if (ids.every((id, i) => id === providers[i].id)) return null
    return ids
  }

  const onProviderDrop = (targetId: string): void => {
    const source = dragProviderId
    const place = dropAfterProvider ? 'after' : 'before'
    setDragProviderId(null)
    setDragOverProviderId(null)
    setDropAfterProvider(false)
    if (!source || source === targetId) return
    const order = reorderWithinProviders(source, targetId, place)
    if (order) void reorderProviders(order)
  }

  useEffect(() => {
    setSearchKey(settings?.webSearchApiKey ?? '')
  }, [settings?.webSearchApiKey])

  useEffect(() => {
    setPrefix(settings?.branchPrefix ?? DEFAULT_BRANCH_PREFIX)
  }, [settings?.branchPrefix])

  useEffect(() => {
    refreshProviders()
    api.system.getVersions().then(setVersions)
    api.updates.getState().then(setUpdate)
    const off = api.updates.onStatus((state) =>
      setUpdate((prev) => (prev ? { ...prev, state } : { version: '', packaged: true, state }))
    )
    return off
  }, [refreshProviders])

  const disconnect = async (id: string): Promise<void> => {
    await api.providers.disconnect(id)
    await refreshProviders()
  }

  const resetEverything = async (): Promise<void> => {
    setResetting(true)
    await api.settings.reset()
    clearActive()
    await bootstrap()
    navigate('/onboarding')
  }

  const saveSearchKey = async (): Promise<void> => {
    await setWebSearchApiKey(searchKey.trim() || null)
    setSearchKeySaved(true)
    setTimeout(() => setSearchKeySaved(false), 2000)
  }

  const us = update?.state
  const updateBusy =
    us?.status === 'checking' || us?.status === 'downloading' || us?.status === 'available'
  const updateLabel = !update?.packaged
    ? 'Auto-updates run in the installed app.'
    : us?.status === 'checking'
      ? 'Checking for updates…'
      : us?.status === 'available'
        ? `Found v${us.version} — downloading…`
        : us?.status === 'downloading'
          ? `Downloading… ${us.percent}%`
          : us?.status === 'downloaded'
            ? `v${us.version} is ready to install.`
            : us?.status === 'error'
              ? `Update check failed: ${us.message}`
              : us?.status === 'not-available'
                ? "You're on the latest version."
                : 'Updates install automatically from GitHub.'

  return (
    <PageShell title="Settings" onBack={() => navigate('/')}>
      <ActivitySection />

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Providers
        </h2>
        <div className="flex flex-col gap-2">
          {providers.map((p) => (
            <div
              key={p.id}
              draggable={providers.length > 1}
              onDragStart={(e) => {
                setDragProviderId(p.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', p.id)
              }}
              onDragEnter={() =>
                dragProviderId && dragProviderId !== p.id && setDragOverProviderId(p.id)
              }
              onDragOver={(e) => {
                if (!dragProviderId) return
                e.preventDefault()
                if (dragProviderId === p.id) return
                const rect = e.currentTarget.getBoundingClientRect()
                const after = e.clientY - rect.top > rect.height / 2
                if (dragOverProviderId !== p.id) setDragOverProviderId(p.id)
                if (after !== dropAfterProvider) setDropAfterProvider(after)
              }}
              onDrop={(e) => {
                e.preventDefault()
                onProviderDrop(p.id)
              }}
              onDragEnd={() => {
                setDragProviderId(null)
                setDragOverProviderId(null)
                setDropAfterProvider(false)
              }}
              className={cn(
                'relative',
                dragProviderId === p.id && 'opacity-40',
                dragOverProviderId === p.id &&
                  dragProviderId !== p.id &&
                  (dropAfterProvider
                    ? 'after:absolute after:inset-x-2 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-accent'
                    : 'before:absolute before:inset-x-2 before:-top-1 before:h-0.5 before:rounded-full before:bg-accent')
              )}
            >
              <ProviderRow
                provider={p}
                active={settings?.activeProviderId === p.id}
                draggable={providers.length > 1}
                dragging={dragProviderId === p.id}
                onDisconnect={() => disconnect(p.id)}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => navigate('/onboarding')}
            className="press-scale flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface/40 p-3.5 text-sm text-text-muted hover:border-border-strong hover:bg-surface hover:text-text"
          >
            <Plus className="h-4 w-4" /> Add provider
          </button>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Workstreams
        </h2>
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">
              New sessions get their own workstream
            </div>
            <p className="mt-0.5 text-xs text-text-muted">
              Each session works in its own git worktree on its own branch, so parallel sessions
              can&apos;t overwrite each other or fight with your editor. The folder is created on
              the session&apos;s first message, and only in git repositories. Turn this off to run
              new sessions directly in the project folder.
            </p>
          </div>
          <Switch
            checked={settings?.autoWorkstream ?? true}
            onChange={(v) => void setAutoWorkstream(v)}
          />
        </div>

        <div className="mt-3 rounded-xl border border-border bg-surface p-4">
          <div className="text-sm font-medium text-text">Branch prefix</div>
          <p className="mt-0.5 text-xs text-text-muted">
            New workstreams get a branch named after the session. This is what goes in front of it —
            use your initials, <code className="text-text-subtle">wip</code>, or clear it for no
            prefix at all.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !prefixError) void setBranchPrefix(prefix)
              }}
              spellCheck={false}
              placeholder="no prefix"
              aria-label="Branch prefix"
              className={cn(
                'w-48 rounded-lg border bg-surface-2 px-3 py-1.5 text-sm text-text outline-none placeholder:text-text-subtle',
                prefixError ? 'border-danger' : 'border-border focus:border-border-strong'
              )}
            />
            {/* The example is the point: "roxy" in a box means nothing until
                you see a whole branch name next to it. Uses a real session
                slug, because that is what branches actually look like. */}
            <span className="min-w-0 truncate font-mono text-xs text-text-subtle">
              {placeholderBranchName(prefix, example)}
            </span>
            <Button
              onClick={() => void setBranchPrefix(prefix)}
              disabled={
                !!prefixError ||
                normalizeBranchPrefix(prefix) === (settings?.branchPrefix ?? DEFAULT_BRANCH_PREFIX)
              }
            >
              Save
            </Button>
          </div>
          {prefixError && <p className="mt-2 text-xs text-danger">{prefixError}</p>}
          <p className="mt-2 text-xs text-text-subtle">
            Only affects new workstreams. Existing branches keep their names — rename one from the
            bar under the composer.
          </p>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Browser
        </h2>
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">Roxy browser</div>
            <p className="mt-0.5 text-xs text-text-muted">
              Opens a persistent browser the agent shares. Sign in to sites here once — your session
              (cookies/logins) is saved, so the agent can act with your access.
            </p>
          </div>
          <Button variant="secondary" className="shrink-0" onClick={() => api.browser.open()}>
            <Globe className="h-3.5 w-3.5" /> Open browser
          </Button>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Web search
        </h2>
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">Exa API key (optional)</div>
            <p className="mt-0.5 text-xs text-text-muted">
              The <code>websearch</code> tool works out of the box on Exa&apos;s free public
              endpoint. Add a key to lift rate limits.{' '}
              <a
                href="https://dashboard.exa.ai/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                Get a key
              </a>
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="password"
              value={searchKey}
              onChange={(e) => setSearchKey(e.target.value)}
              placeholder="exa_…"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface-strong px-3 py-2 text-sm text-text outline-none placeholder:text-text-subtle focus:border-border-strong"
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              variant="secondary"
              className="shrink-0"
              disabled={searchKey.trim() === (settings?.webSearchApiKey ?? '')}
              onClick={() => void saveSearchKey()}
            >
              {searchKeySaved ? 'Saved' : 'Save'}
            </Button>
          </div>
        </div>
      </section>

      {/* Distinct from "Providers" above on purpose: that list is who runs the
          MODEL, this one is where the CODE lives. GitHub appears in both, as
          two unrelated accounts. */}
      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Code hosts
        </h2>
        <CodeHosts />
      </section>
      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
          MCP servers
        </h2>
        <McpServers />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Backup &amp; restore
        </h2>
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">Skills &amp; MCP servers</div>
            <p className="mt-0.5 text-xs text-text-muted">
              Export your global skills and MCP server configs to a single file, then import it on
              another computer to set it up the same way. Importing overwrites skills/servers that
              share a name.{' '}
              <span className="text-text-subtle">
                Heads up: the file includes any MCP secrets (headers/env) in plain text — keep it
                private.
              </span>
            </p>
          </div>
          <ConfigBackup onImported={() => void bootstrap()} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
          About
        </h2>
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-text">Roxy v{versions?.app ?? '—'}</div>
              <p className="mt-0.5 text-xs text-text-muted">{updateLabel}</p>
            </div>
            {update?.state.status === 'downloaded' ? (
              <Button variant="primary" className="shrink-0" onClick={() => api.updates.install()}>
                Restart to update
              </Button>
            ) : (
              <Button
                variant="secondary"
                className="shrink-0"
                disabled={!update?.packaged || updateBusy}
                onClick={() => void api.updates.check()}
                title={update?.packaged ? undefined : 'Available in the installed app'}
              >
                {updateBusy ? 'Checking…' : 'Check for updates'}
              </Button>
            )}
          </div>
          {versions && (
            <p className="text-[11px] text-text-subtle">
              Electron {versions.electron} · Chromium {versions.chrome} · Node {versions.node}
            </p>
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-danger">
          Danger zone
        </h2>
        <div className="flex flex-col gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">Reset everything</div>
            <p className="mt-0.5 text-xs text-text-muted">
              Wipes all providers, sessions, loops, and settings, then returns to onboarding. This
              can&apos;t be undone.
            </p>
          </div>
          {confirmingReset ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => setConfirmingReset(false)}
                disabled={resetting}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={resetEverything} disabled={resetting}>
                {resetting ? 'Wiping…' : 'Yes, wipe everything'}
              </Button>
            </div>
          ) : (
            <Button variant="danger" className="shrink-0" onClick={() => setConfirmingReset(true)}>
              <Trash2 className="h-3.5 w-3.5" /> Reset everything
            </Button>
          )}
        </div>
      </section>
    </PageShell>
  )
}

function ProviderRow({
  provider,
  active,
  draggable,
  dragging,
  onDisconnect
}: {
  provider: ConnectedProvider
  active: boolean
  draggable: boolean
  dragging: boolean
  onDisconnect: () => void
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border border-border bg-surface p-3.5 transition',
        dragging && 'cursor-grabbing',
        draggable && !dragging && 'cursor-grab'
      )}
    >
      <GripVertical
        className={cn(
          'h-4 w-4 shrink-0 text-text-subtle transition',
          draggable ? 'opacity-70' : 'opacity-20'
        )}
        aria-hidden="true"
      />
      <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-2">
        <ProviderLogo id={provider.id} name={provider.name} size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">{provider.name}</span>
          {active && (
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success">
              Active
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-text-subtle">
          {AUTH_LABELS[provider.auth]} ·{' '}
          {provider.auth === 'subscription'
            ? 'signed in locally'
            : provider.hasCredential
              ? 'key stored'
              : 'no credential'}
        </p>
        {/* Subscription providers hold their credential in the sidecar, not in
            Roxy - so the row lists the signed-in accounts instead of a key. */}
        {provider.auth === 'subscription' && <CodexAccounts />}
      </div>
      <Button size="sm" variant="ghost" onClick={onDisconnect}>
        Disconnect
      </Button>
    </div>
  )
}
