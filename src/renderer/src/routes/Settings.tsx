import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Globe, Plus, Trash2 } from 'lucide-react'
import type { AppVersions, ConnectedProvider } from '@shared/types'
import type { UpdateInfo } from '@shared/api'
import { AUTH_LABELS } from '@shared/providers'
import { api } from '../lib/api'
import { Button } from '../components/ui'
import { PageShell } from '../components/PageShell'
import { ProviderLogo } from '../lib/providerLogos'
import { useRoxyStore } from '../lib/store'

export default function Settings(): JSX.Element {
  const navigate = useNavigate()
  const providers = useRoxyStore((s) => s.providers)
  const settings = useRoxyStore((s) => s.settings)
  const refreshProviders = useRoxyStore((s) => s.refreshProviders)
  const bootstrap = useRoxyStore((s) => s.bootstrap)
  const clearActive = useRoxyStore((s) => s.clearActive)
  const [versions, setVersions] = useState<AppVersions | null>(null)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetting, setResetting] = useState(false)

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
      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Providers
        </h2>
        <div className="flex flex-col gap-2">
          {providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              active={settings?.activeProviderId === p.id}
              onDisconnect={() => disconnect(p.id)}
            />
          ))}
          <button
            type="button"
            onClick={() => navigate('/onboarding')}
            className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface/40 p-3.5 text-sm text-text-muted transition hover:border-border-strong hover:bg-surface hover:text-text"
          >
            <Plus className="h-4 w-4" /> Add provider
          </button>
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

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">About</h2>
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
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-danger">Danger zone</h2>
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
              <Button variant="ghost" onClick={() => setConfirmingReset(false)} disabled={resetting}>
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
  onDisconnect
}: {
  provider: ConnectedProvider
  active: boolean
  onDisconnect: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3.5">
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
          {AUTH_LABELS[provider.auth]} · {provider.hasCredential ? 'key stored' : 'no credential'}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={onDisconnect}>
        Disconnect
      </Button>
    </div>
  )
}
