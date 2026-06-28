import { useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronRight, Copy, ExternalLink, Loader2, Search } from 'lucide-react'
import { AUTH_LABELS, SEED_PROVIDERS, isConnectableNow, resolveSeed } from '@shared/providers'
import type { DeviceFlowStart, SeedProvider } from '@shared/types'
import { api } from '../../lib/api'
import { useRoxyStore } from '../../lib/store'
import { Button, Input } from '../../components/ui'
import { ProviderLogo } from '../../lib/providerLogos'

export function ProviderStep(): JSX.Element {
  const providers = useRoxyStore((s) => s.providers)
  const connectedIds = new Set(providers.map((p) => p.id))
  const [query, setQuery] = useState('')
  const [setupId, setSetupId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SEED_PROVIDERS
    return SEED_PROVIDERS.filter((p) => p.name.toLowerCase().includes(q) || p.id.includes(q))
  }, [query])

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Connect a provider</h1>
      <p className="mt-2 text-sm text-text-muted">
        Roxy talks to every major AI provider. Search the list and pick one — add more anytime in
        Settings.
      </p>

      {providers.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {providers.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs text-success"
            >
              <Check className="h-3 w-3" /> {p.name}
            </span>
          ))}
        </div>
      )}

      <div className="relative mt-6">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-subtle" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${SEED_PROVIDERS.length} providers…`}
          className="pl-9"
          autoFocus
        />
      </div>

      <div className="mt-3 max-h-[360px] overflow-y-auto rounded-xl border border-border bg-surface">
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-text-subtle">
            No providers match “{query}”.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((seed) => (
              <ProviderRow
                key={seed.id}
                seed={seed}
                connected={connectedIds.has(seed.id)}
                onClick={() => setSetupId(seed.id)}
              />
            ))}
          </div>
        )}
      </div>

      {setupId && <ProviderSetup seed={resolveSeed(setupId)} onClose={() => setSetupId(null)} />}
    </div>
  )
}

function ProviderRow({
  seed,
  connected,
  onClick
}: {
  seed: SeedProvider
  connected: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-white/5"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2">
        <ProviderLogo id={seed.id} name={seed.name} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text">{seed.name}</span>
          {connected && <Check className="h-3.5 w-3.5 shrink-0 text-success" />}
        </span>
        <span className="block truncate text-xs text-text-subtle">{AUTH_LABELS[seed.auth]}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-text-subtle" />
    </button>
  )
}

function ProviderSetup({ seed, onClose }: { seed: SeedProvider; onClose: () => void }): JSX.Element {
  const refreshProviders = useRoxyStore((s) => s.refreshProviders)
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState(seed.baseURL ?? '')
  const [model, setModel] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isCopilot = seed.auth === 'device-flow' && seed.id === 'github-copilot'
  const needsKey = seed.auth === 'api-key'
  const needsBaseURL = !seed.baseURL
  const showBaseURL = needsBaseURL || seed.auth === 'none' || seed.id === 'openai-compatible'
  const canConnect =
    isConnectableNow(seed) &&
    (!needsKey || apiKey.trim().length > 0) &&
    (!needsBaseURL || baseURL.trim().length > 0)

  const connect = async (): Promise<void> => {
    setConnecting(true)
    setError(null)
    try {
      const provider = await api.providers.connect({
        id: seed.id,
        apiKey: apiKey.trim() || undefined,
        baseURL: baseURL.trim() || undefined,
        defaultModel: model.trim() || undefined
      })
      await api.settings.setActiveProvider(provider.id, model.trim() || provider.defaultModel || null)
      await refreshProviders()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConnecting(false)
    }
  }

  const onConnected = async (): Promise<void> => {
    await refreshProviders()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="titlebar reserve-controls-left reserve-controls-right flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <button
          onClick={onClose}
          title="Back"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-text"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-2">
          <ProviderLogo id={seed.id} name={seed.name} size={20} />
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold">{seed.name}</div>
          <div className="text-xs text-text-subtle">{AUTH_LABELS[seed.auth]}</div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-md px-6 py-10">
          {isCopilot ? (
            <CopilotSetup onConnected={onConnected} />
          ) : isConnectableNow(seed) ? (
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="text-lg font-semibold">Set up {seed.name}</h2>
                <p className="mt-1 text-sm text-text-muted">
                  {needsKey ? 'Paste an API key to connect.' : 'Point Roxy at your local endpoint.'}
                </p>
              </div>
              {needsKey && (
                <Field label="API key">
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-…"
                    autoFocus
                  />
                </Field>
              )}
              {showBaseURL && (
                <Field label="Base URL">
                  <Input
                    value={baseURL}
                    onChange={(e) => setBaseURL(e.target.value)}
                    placeholder="https://…"
                  />
                </Field>
              )}
              <Field label="Default model (optional)">
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. gpt-4o, claude-3-5-sonnet"
                />
              </Field>
              {error && <p className="text-xs text-danger">{error}</p>}
              <div className="flex items-center gap-2">
                <Button variant="primary" onClick={connect} disabled={!canConnect || connecting}>
                  {connecting ? 'Connecting…' : 'Connect'}
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              </div>
              <p className="text-[11px] text-text-subtle">
                Keys are encrypted with your OS keychain and stored locally.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="text-lg font-semibold">Set up {seed.name}</h2>
                <p className="mt-1 text-sm text-text-muted">
                  Guided <span className="text-text">{AUTH_LABELS[seed.auth]}</span> sign-in is
                  coming soon. API-key and local providers (and GitHub Copilot) work today.
                </p>
              </div>
              <Button variant="ghost" onClick={onClose}>
                Back to list
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CopilotSetup({ onConnected }: { onConnected: () => void }): JSX.Element {
  const [status, setStatus] = useState<'idle' | 'waiting' | 'error'>('idle')
  const [flow, setFlow] = useState<DeviceFlowStart | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const begin = async (): Promise<void> => {
    setStatus('waiting')
    setError(null)
    try {
      const started = await api.copilot.start()
      setFlow(started)
      await api.system.openExternal(started.verificationUri)
      await api.copilot.poll(started.deviceCode, started.interval)
      onConnected()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  const copyCode = async (): Promise<void> => {
    if (!flow) return
    await navigator.clipboard.writeText(flow.userCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (status === 'idle') {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">Sign in to GitHub Copilot</h2>
          <p className="mt-1 text-sm text-text-muted">
            Authorize Roxy with your GitHub account using a device code. Requires an active Copilot
            subscription.
          </p>
        </div>
        <Button variant="primary" onClick={begin}>
          <ProviderLogo id="github-copilot" name="GitHub" size={16} /> Continue with GitHub
        </Button>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Couldn’t connect</h2>
        <p className="text-sm text-danger">{error}</p>
        <Button variant="secondary" onClick={begin}>
          Try again
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div>
        <h2 className="text-lg font-semibold">Enter this code on GitHub</h2>
        <p className="mt-1 text-sm text-text-muted">
          We opened github.com/login/device in your browser. Enter the code to authorize Roxy.
        </p>
      </div>
      <button
        onClick={copyCode}
        className="group flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-5 py-3 transition hover:border-border-strong"
      >
        <span className="font-mono text-2xl font-semibold tracking-[0.3em] text-text">
          {flow?.userCode ?? '••••-••••'}
        </span>
        <Copy className="h-4 w-4 text-text-subtle transition group-hover:text-text" />
      </button>
      <span className="text-xs text-text-subtle">{copied ? 'Copied!' : 'Click the code to copy'}</span>
      <Button variant="secondary" onClick={() => flow && api.system.openExternal(flow.verificationUri)}>
        <ExternalLink className="h-4 w-4" /> Open GitHub
      </Button>
      <div className="mt-1 flex items-center gap-2 text-sm text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Waiting for authorization…
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-muted">{label}</span>
      {children}
    </label>
  )
}
