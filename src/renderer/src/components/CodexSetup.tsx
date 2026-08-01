/**
 * Codex subscription sign-in — the panel behind the `codex-subscription`
 * provider.
 *
 * Everything real happens in the main process (download the pinned CLIProxyAPI
 * release, run it on loopback, drive the ChatGPT OAuth flow). This component is
 * deliberately thin: one button, an honest description of what gets installed,
 * and live status pushed from `cliproxy:state`.
 *
 * The download is the only part that takes visible time, so it's the only part
 * with a progress bar. Everything else is fast enough that a spinner and a
 * sentence beats a multi-step wizard.
 */
import { useEffect, useState } from 'react'
import { Check, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import { IDLE_CLIPROXY_STATE, type CliProxyState } from '@shared/cliproxy'
import { api } from '../lib/api'
import { Button } from './ui'

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

export function CodexSetup({ onConnected }: { onConnected: () => void }): JSX.Element {
  const state = useCliProxyState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signIn = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.cliproxy.login()
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

  const connected = state.accounts.length > 0

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Use your ChatGPT subscription</h2>
        <p className="mt-1 text-sm text-text-muted">
          Sign in with the ChatGPT account behind your Plus, Pro, or Team plan and run Roxy on the
          models it already includes — no API key and no per-token bill.
        </p>
      </div>

      {connected && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-success/30 bg-success/10 p-3">
          {state.accounts.map((a) => (
            <div key={a.file} className="flex items-center gap-2 text-sm text-success">
              <Check className="h-4 w-4 shrink-0" />
              <span className="truncate">{a.email || a.file}</span>
            </div>
          ))}
        </div>
      )}

      {busy && <Progress state={state} />}

      {error && <p className="text-xs text-danger">{error}</p>}

      <Button variant="primary" onClick={signIn} disabled={busy}>
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Waiting for sign-in…
          </>
        ) : connected ? (
          'Add another account'
        ) : (
          <>
            Continue with ChatGPT <ExternalLink className="h-4 w-4" />
          </>
        )}
      </Button>

      <HowItWorks version={state.version} />
    </div>
  )
}

/** Live status while a sign-in is in flight. */
function Progress({ state }: { state: CliProxyState }): JSX.Element {
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
  const label =
    state.status === 'starting'
      ? 'Starting the local proxy…'
      : 'Finish signing in with ChatGPT in your browser.'
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 p-3 text-sm text-text-muted">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      <span>{label}</span>
    </div>
  )
}

/**
 * What actually gets installed. This runs a third-party binary that holds the
 * user's ChatGPT credentials, so saying so plainly — before the click, not in a
 * changelog — is the only honest option.
 */
function HowItWorks({ version }: { version: string }): JSX.Element {
  return (
    <div className="flex gap-2.5 rounded-xl border border-border bg-surface p-3">
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
        (checksum-verified) and runs it on 127.0.0.1 while Roxy is open. It holds the ChatGPT login
        on this machine and exposes it to Roxy as a normal model endpoint — your credentials never
        reach Roxy&apos;s servers, and the proxy is closed when you quit.
      </div>
    </div>
  )
}

/** Signed-in accounts + proxy status, for the Settings provider row. */
export function CodexAccounts(): JSX.Element | null {
  const state = useCliProxyState()
  const [busy, setBusy] = useState<string | null>(null)
  if (state.accounts.length === 0 && state.status !== 'error') return null

  const signOut = async (file: string): Promise<void> => {
    setBusy(file)
    try {
      await api.cliproxy.signOut(file)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {state.accounts.map((a) => (
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
