/**
 * Subscription sign-in — the panel behind every `auth: 'subscription'` provider
 * (ChatGPT/Codex today, Google Gemini alongside it).
 *
 * Everything real happens in the main process (download the pinned CLIProxyAPI
 * release, run it on loopback, drive the provider's OAuth flow). This component
 * is deliberately thin: one button, an honest description of what gets
 * installed, and live status pushed from `cliproxy:state`.
 *
 * One sidecar process serves every subscription, so the pushed state is SHARED:
 * install status, port and progress are global, while the account list covers
 * all upstreams at once. Each panel therefore narrows that list to its own
 * provider with `accountsFor` — without which signing into ChatGPT would light
 * up the Gemini panel as "connected" too.
 *
 * The download is the only part that takes visible time, so it's the only part
 * with a progress bar. Everything else is fast enough that a spinner and a
 * sentence beats a multi-step wizard.
 */
import { useEffect, useState } from 'react'
import { Check, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import {
  CODEX_PROVIDER_ID,
  IDLE_CLIPROXY_STATE,
  accountsFor,
  upstreamFor,
  type CliProxyState
} from '@shared/cliproxy'
import { api } from '../lib/api'
import { Button } from './ui'

/** Per-provider wording. The mechanics are identical; only the nouns differ. */
const COPY: Record<string, { title: string; blurb: string; cta: string; browser: string }> = {
  [CODEX_PROVIDER_ID]: {
    title: 'Use your ChatGPT subscription',
    blurb:
      'Sign in with the ChatGPT account behind your Plus, Pro, or Team plan and run Roxy on the models it already includes — no API key and no per-token bill.',
    cta: 'Continue with ChatGPT',
    browser: 'Finish signing in with ChatGPT in your browser.'
  },
  'gemini-subscription': {
    title: 'Use your Google Gemini subscription',
    blurb:
      'Sign in with the Google account behind your Gemini plan and run Roxy on the Gemini models it already includes — no API key and no per-token bill.',
    cta: 'Continue with Google',
    browser: 'Finish signing in with Google in your browser.'
  },
  'claude-subscription': {
    title: 'Use your Claude subscription',
    blurb:
      'Sign in with the Anthropic account behind your Claude Pro or Max plan and run Roxy on the Claude models it already includes — no API key and no per-token bill.',
    cta: 'Continue with Claude',
    browser: 'Finish signing in with Claude in your browser.'
  }
}

function copyFor(providerId: string): (typeof COPY)[string] {
  return (
    COPY[providerId] ?? {
      title: 'Use your subscription',
      blurb: 'Sign in with the account behind your plan and use it here — no API key required.',
      cta: 'Continue',
      browser: 'Finish signing in in your browser.'
    }
  )
}

/** Subscribe to sidecar state, seeded with its current value. */
export function useCliProxyState(): CliProxyState {
  const [state, setState] = useState<CliProxyState>(IDLE_CLIPROXY_STATE)
  useEffect(() => {
    let live = true
    void api.cliproxy.status().then((s) => {
      if (live) setState(s)
    })
    // Drop out-of-order pushes: `status()` above and the subscription race, and
    // a stale reply must not overwrite a newer pushed state.
    const off = api.cliproxy.onState((s) => setState((prev) => (s.rev >= prev.rev ? s : prev)))
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

export function SubscriptionSetup({
  providerId,
  onConnected
}: {
  providerId: string
  onConnected: () => void
}): JSX.Element {
  const state = useCliProxyState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const copy = copyFor(providerId)

  const signIn = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.cliproxy.login(providerId)
      if (!result.ok) {
        setError(result.error ?? 'Sign-in failed.')
        return
      }
      onConnected()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Escape hatch for networks that block or rewrite the download: the user
   * supplies the archive themselves, then sign-in continues as normal.
   */
  const installManually = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await api.cliproxy.installFromFile()
      // A cancelled picker leaves the state untouched - don't claim success.
      if (next.status === 'not-installed') {
        if (next.error) setError(next.error)
        return
      }
      await signIn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Only THIS provider's accounts. The state carries every upstream's.
  const accounts = accountsFor(state, providerId)
  const connected = accounts.length > 0

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="mt-1 text-sm text-text-muted">{copy.blurb}</p>
      </div>

      {connected && (
        <div className="flex flex-col gap-1.5 sq sq-xl sq-ring [--sq-ring:color-mix(in_srgb,var(--color-success)_30%,transparent)] rounded-xl border border-success/30 bg-success/10 p-3">
          {accounts.map((a) => (
            <div key={a.file} className="flex items-center gap-2 text-sm text-success">
              <Check className="h-4 w-4 shrink-0" />
              <span className="truncate">{a.email || a.file}</span>
            </div>
          ))}
        </div>
      )}

      {busy && <Progress state={state} browserLabel={copy.browser} />}

      {error && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-danger">{error}</p>
          {/* Only offered after a failure. Some networks rewrite or block the
              download outright, and retrying cannot fix that — but the user can
              fetch the file another way. It is still checksum-verified. */}
          <button
            type="button"
            onClick={installManually}
            disabled={busy}
            className="self-start text-xs text-text-subtle underline-offset-2 transition-colors hover:text-text hover:underline disabled:opacity-40"
          >
            Download blocked? Install from a file instead
          </button>
        </div>
      )}

      <Button variant="primary" onClick={signIn} disabled={busy}>
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Waiting for sign-in…
          </>
        ) : connected ? (
          'Add another account'
        ) : (
          <>
            {copy.cta} <ExternalLink className="h-4 w-4" />
          </>
        )}
      </Button>

      <HowItWorks version={state.version} />
    </div>
  )
}

/** Live status while a sign-in is in flight. */
function Progress({
  state,
  browserLabel
}: {
  state: CliProxyState
  browserLabel: string
}): JSX.Element {
  if (state.status === 'downloading') {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>Downloading the local proxy…</span>
          <span className="tabular-nums">{state.progress}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${state.progress}%` }}
          />
        </div>
      </div>
    )
  }
  const label = state.status === 'starting' ? 'Starting the local proxy…' : browserLabel
  return (
    <div className="flex items-center gap-2 sq sq-xl sq-ring rounded-xl border border-border bg-surface-2 p-3 text-sm text-text-muted">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      <span>{label}</span>
    </div>
  )
}

/**
 * What actually gets installed. This runs a third-party binary that holds the
 * user's subscription credentials, so saying so plainly — before the click, not
 * in a changelog — is the only honest option.
 */
function HowItWorks({ version }: { version: string }): JSX.Element {
  return (
    <div className="flex gap-2.5 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-3">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-text-subtle" />
      <div className="text-xs leading-relaxed text-text-subtle">
        Roxy downloads{' '}
        <button
          type="button"
          onClick={() =>
            void api.system.openExternal('https://github.com/router-for-me/CLIProxyAPI')
          }
          className="text-accent transition-colors hover:underline"
        >
          CLIProxyAPI v{version}
        </button>{' '}
        (checksum-verified) and runs it on 127.0.0.1 while Roxy is open. It holds the login on this
        machine and exposes it to Roxy as a normal model endpoint — your credentials never reach
        Roxy&apos;s servers, and the proxy is closed when you quit.
      </div>
    </div>
  )
}

/** Signed-in accounts + proxy status, for a Settings provider row. */
export function SubscriptionAccounts({ providerId }: { providerId: string }): JSX.Element | null {
  const state = useCliProxyState()
  const [busy, setBusy] = useState<string | null>(null)
  const accounts = accountsFor(state, providerId)
  // The error is global to the sidecar, so it is only worth showing on a row
  // that has something at stake here - otherwise both rows would report the
  // same failure twice.
  if (accounts.length === 0 && state.status !== 'error') return null

  const signOut = async (file: string): Promise<void> => {
    setBusy(file)
    try {
      await api.cliproxy.signOut(providerId, file)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {accounts.map((a) => (
        <div key={a.file} className="flex items-center gap-2 text-xs text-text-muted">
          <span className="truncate">{a.email || a.file}</span>
          <button
            onClick={() => void signOut(a.file)}
            disabled={busy === a.file}
            className="text-text-subtle transition-colors hover:text-danger disabled:opacity-40"
          >
            {busy === a.file ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ))}
      {state.error && <p className="text-xs text-danger">{state.error}</p>}
    </div>
  )
}

/** Whether a provider id is one this panel knows how to sign into. */
export function isSubscriptionProvider(providerId: string): boolean {
  return upstreamFor(providerId) !== undefined
}
