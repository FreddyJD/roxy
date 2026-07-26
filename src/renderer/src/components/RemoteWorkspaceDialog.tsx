import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Loader2, MonitorSmartphone, ShieldCheck, Smartphone, X } from 'lucide-react'
import { useRoxyStore } from '../lib/store'
import { Button } from './ui'

/**
 * Remote Workspace popup — take the running session to a phone.
 *
 * Opening it auto-starts a share (mint room + dial the relay); the body then
 * shows the safe URL, an offline QR code, and the PIN to enter on the phone.
 * Closing the popup keeps the share alive (the sidebar keeps its live dot);
 * only **Stop sharing** tears down the room + revokes the tokens.
 */
export function RemoteWorkspaceDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const remote = useRoxyStore((s) => s.remote)
  const activeChatId = useRoxyStore((s) => s.activeChatId)
  const chats = useRoxyStore((s) => s.chats)
  const startRemote = useRoxyStore((s) => s.startRemote)
  const stopRemote = useRoxyStore((s) => s.stopRemote)
  const refreshRemote = useRoxyStore((s) => s.refreshRemote)
  const [copied, setCopied] = useState(false)
  const [stopping, setStopping] = useState(false)

  // The session the phone is currently viewing (it can switch between all of them).
  const viewingName =
    chats.find((c) => c.id === (remote.sessionId ?? activeChatId))?.title ?? 'this session'

  // On open, sync the real sharing status first (a share may already be live
  // from before this window loaded), then auto-start only if still idle.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await refreshRemote()
      if (cancelled) return
      const s = useRoxyStore.getState()
      if (s.remote.phase === 'idle' && s.activeChatId) void s.startRemote()
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ESC closes the popup (without stopping the share).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copyUrl = async (): Promise<void> => {
    if (!remote.url) return
    try {
      await navigator.clipboard.writeText(remote.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be denied — the URL is still visible to copy manually.
    }
  }

  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      await stopRemote()
    } finally {
      setStopping(false)
    }
  }

  const sharing = remote.phase === 'live' || remote.phase === 'offline'

  return (
    <div
      className="animate-scrim-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="animate-modal-in w-full max-w-md overflow-hidden rounded-2xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <MonitorSmartphone className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">Remote Workspace</h2>
              {(remote.phase === 'live' || remote.phase === 'offline') && (
                <LiveBadge phase={remote.phase} />
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-text-muted">
              Take your whole workspace to your phone — scan, enter the PIN, and switch between any
              session from anywhere.
            </p>
          </div>
          <button
            onClick={onClose}
            title="Close (keeps sharing)"
            className="press-scale flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-white/5 hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5">
          {!activeChatId && remote.phase === 'idle' ? (
            <EmptyState />
          ) : remote.phase === 'starting' ? (
            <StartingState />
          ) : remote.phase === 'error' ? (
            <ErrorState message={remote.error} onRetry={() => void startRemote()} />
          ) : sharing ? (
            <ShareView
              url={remote.url}
              pin={remote.pin}
              guests={remote.guests}
              viewingName={viewingName}
              copied={copied}
              onCopy={() => void copyUrl()}
            />
          ) : (
            // phase === 'idle' with a session (e.g. after Stop) → offer to start.
            <IdleState onStart={() => void startRemote()} />
          )}
        </div>

        {/* Footer */}
        {sharing && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
            <span className="text-[11px] text-text-subtle">
              The link + PIN stop working the moment you stop sharing.
            </span>
            <Button variant="danger" size="sm" onClick={() => void stop()} disabled={stopping}>
              {stopping ? 'Stopping…' : 'Stop sharing'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Green "Live" / amber "Reconnecting" pill next to the title. */
function LiveBadge({ phase }: { phase: 'live' | 'offline' }): JSX.Element {
  if (phase === 'offline') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
        Reconnecting
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
      </span>
      Live
    </span>
  )
}

/** The main share view: QR, URL + copy, PIN, and a device indicator. */
function ShareView({
  url,
  pin,
  guests,
  viewingName,
  copied,
  onCopy
}: {
  url?: string
  pin?: string
  guests: number
  viewingName: string
  copied: boolean
  onCopy: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4">
      {/* QR — rendered locally, nothing leaves the machine. */}
      <div className="rounded-2xl bg-white p-3 shadow-sm">
        {url ? (
          <QRCodeSVG value={url} size={188} level="M" marginSize={1} fgColor="#0b0b0f" />
        ) : (
          <div className="flex h-[188px] w-[188px] items-center justify-center text-black/40">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
      </div>

      <p className="text-center text-xs text-text-muted">
        Scan with your phone camera, or open the link:
      </p>

      {/* Safe URL + copy */}
      <div className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted">{url}</span>
        <button
          onClick={onCopy}
          title="Copy link"
          className="press-scale flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-text-muted hover:bg-white/5 hover:text-text"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-success" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </button>
      </div>

      {/* PIN — the second factor, shown big. */}
      <div className="flex w-full flex-col items-center gap-2 rounded-xl border border-border bg-surface-2 py-4">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-subtle">
          Enter this PIN on your phone
        </span>
        <Pin pin={pin} />
      </div>

      {/* Device indicator */}
      <div className="flex flex-col items-center gap-1 text-xs">
        {guests > 0 ? (
          <>
            <span className="inline-flex items-center gap-1.5 font-medium text-success">
              <Smartphone className="h-3.5 w-3.5" />
              {guests} device{guests === 1 ? '' : 's'} connected
            </span>
            <span className="text-[11px] text-text-subtle">
              Viewing <span className="text-text-muted">{viewingName}</span>
            </span>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-subtle" />
            Waiting for your phone to connect…
          </span>
        )}
      </div>

      {/* Privacy reassurance — the core of the security model, at a glance. */}
      <p className="inline-flex items-center gap-1.5 text-center text-[11px] leading-snug text-text-subtle">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success/80" />
        Your code and files stay on this computer — only the chat is relayed, over an encrypted link.
      </p>
    </div>
  )
}

/** PIN digits, each in its own box. */
function Pin({ pin }: { pin?: string }): JSX.Element {
  if (!pin) return <Loader2 className="h-5 w-5 animate-spin text-text-subtle" />
  return (
    <div className="flex items-center gap-1.5">
      {pin.split('').map((d, i) => (
        <span
          key={i}
          className="flex h-10 w-8 items-center justify-center rounded-lg border border-border bg-surface font-mono text-xl font-semibold tabular-nums text-text"
        >
          {d}
        </span>
      ))}
    </div>
  )
}

function StartingState(): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <Loader2 className="h-7 w-7 animate-spin text-accent" />
      <p className="text-sm font-medium">Starting your Remote Workspace…</p>
      <p className="text-xs text-text-muted">Creating a secure room and dialing the relay.</p>
    </div>
  )
}

function IdleState({ onStart }: { onStart: () => void }): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-accent">
        <MonitorSmartphone className="h-6 w-6" />
      </div>
      <p className="max-w-xs text-sm text-text-muted">
        Share this session to your phone with a secure link + PIN. Your code and files never leave
        your machine — the phone is just a remote control.
      </p>
      <Button variant="primary" onClick={onStart}>
        Start sharing
      </Button>
    </div>
  )
}

function EmptyState(): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-text-muted">
        <MonitorSmartphone className="h-6 w-6" />
      </div>
      <p className="text-sm font-medium">No session open</p>
      <p className="max-w-xs text-xs text-text-muted">
        Open or create a session first, then share it to your phone from here.
      </p>
    </div>
  )
}

function ErrorState({
  message,
  onRetry
}: {
  message?: string
  onRetry: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
        <X className="h-6 w-6" />
      </div>
      <p className="text-sm font-medium">Couldn’t start sharing</p>
      <p className="max-w-xs text-xs text-text-muted">{message ?? 'Something went wrong.'}</p>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
