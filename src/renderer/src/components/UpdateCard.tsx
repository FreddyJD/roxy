import { useEffect, useState } from 'react'
import { Download, RotateCw, Sparkles } from 'lucide-react'
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
        <Sparkles className="h-4 w-4 shrink-0 text-accent" />
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
