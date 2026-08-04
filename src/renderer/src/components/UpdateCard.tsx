import { useEffect, useState } from 'react'
import { Download, RotateCw } from 'lucide-react'
import type { UpdateInfo, UpdateState } from '@shared/api'
import { api } from '../lib/api'
import { Button } from './ui'

/**
 * A card pinned to the bottom of the sidebar while an auto-update is downloading
 * or ready to install. "Restart & update" relaunches into the new version.
 *
 * The updater is inert in dev (it only runs in the packaged app), so to preview
 * the card during development set localStorage `roxy.previewUpdate` to '1'.
 */
/** Bell with a notification dot — solid, inherits `currentColor`. */
function BellRing({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M15.7501 20.5001C15.0346 21.8389 13.6241 22.7501 12.0001 22.7501C10.3761 22.7501 8.96557 21.8389 8.25009 20.5001H15.7501Z" />
      <path d="M18.0001 8.75012C20.0711 8.75012 21.7501 7.07118 21.7501 5.00012C21.7501 2.92905 20.0711 1.25012 18.0001 1.25012C15.929 1.25012 14.2501 2.92905 14.2501 5.00012C14.2501 7.07117 15.929 8.75012 18.0001 8.75012Z" />
      <path d="M12.0001 2.25012C12.5857 2.25012 13.1558 2.3165 13.7042 2.43958C13.2568 3.18849 13.0001 4.06437 13.0001 5.00012C13.0001 7.76152 15.2387 10.0001 18.0001 10.0001C18.613 10.0001 19.1996 9.88845 19.7423 9.68665C19.7464 9.79064 19.7501 9.89511 19.7501 10.0001V13.6876L21.0128 14.9503C21.485 15.4227 21.7501 16.0637 21.7501 16.7316C21.7499 18.1225 20.6224 19.25 19.2315 19.2501H4.76865C3.37776 19.25 2.25026 18.1225 2.25009 16.7316C2.25009 16.0637 2.51521 15.4227 2.9874 14.9503L4.25009 13.6876V10.0001C4.25009 5.71992 7.71989 2.25012 12.0001 2.25012Z" />
    </svg>
  )
}

export function UpdateCard(): JSX.Element | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  useEffect(() => {
    api.updates.getState().then(setInfo)
    const off = api.updates.onStatus((state) =>
      setInfo((prev) => (prev ? { ...prev, state } : { version: '', packaged: true, state }))
    )
    return off
  }, [])

  const preview =
    typeof localStorage !== 'undefined' && localStorage.getItem('roxy.previewUpdate') === '1'
  const state: UpdateState | undefined = preview
    ? { status: 'downloaded', version: info?.version || '0.0.0' }
    : info?.state
  if (!state || (state.status !== 'downloaded' && state.status !== 'downloading')) return null

  if (state.status === 'downloading') {
    return (
      <div className="mx-3 mb-3 shrink-0 rounded-xl border border-border bg-surface-2 p-3">
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4 shrink-0 animate-pulse text-accent" />
          <span className="flex-1 truncate text-xs font-medium text-text">Downloading update…</span>
          <span className="text-xs tabular-nums text-text-muted">{state.percent}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${state.percent}%` }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-3 mb-3 shrink-0 overflow-hidden rounded-xl border border-accent/30 bg-accent/10 p-3">
      <div className="flex items-center gap-2">
        <BellRing className="h-4 w-4 shrink-0 text-accent" />
        <span className="text-sm font-semibold text-text">Update ready</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-text-muted">
        Roxy {state.version} is downloaded and ready to install.
      </p>
      <Button
        variant="primary"
        size="sm"
        className="mt-2.5 w-full"
        onClick={() => void api.updates.install()}
      >
        <RotateCw className="h-3.5 w-3.5" /> Restart &amp; update
      </Button>
    </div>
  )
}
