import { useState } from 'react'
import { Download, Upload } from 'lucide-react'
import type { ConfigImportResult } from '@shared/api'
import { api } from '../lib/api'
import { Button } from './ui'

/**
 * Export/Import buttons for the portable config bundle (global skills + MCP
 * server configs). Reused in Settings (both features) and — scoped down via the
 * `only` prop for labels — could sit on the Skills / MCP pages. Everything is a
 * no-op on cancel; a short status line reports the outcome.
 *
 * `onImported` lets the host refresh whatever it shows (skills list, MCP list)
 * after a successful import.
 */
export function ConfigBackup({
  onImported,
  className
}: {
  onImported?: (result: ConfigImportResult) => void
  className?: string
}): JSX.Element {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const doExport = async (): Promise<void> => {
    setBusy('export')
    setStatus(null)
    try {
      const res = await api.config.export()
      if (res.error) {
        setStatus({ tone: 'err', text: `Export failed: ${res.error}` })
      } else if (!res.ok) {
        // Cancelled the save dialog — say nothing loud.
        setStatus(null)
      } else {
        setStatus({ tone: 'ok', text: `Exported ${res.summary}.` })
      }
    } catch (e) {
      setStatus({ tone: 'err', text: e instanceof Error ? e.message : 'Export failed.' })
    } finally {
      setBusy(null)
    }
  }

  const doImport = async (): Promise<void> => {
    setBusy('import')
    setStatus(null)
    try {
      const res = await api.config.import()
      if (res.cancelled) {
        setStatus(null)
      } else if (!res.ok) {
        setStatus({ tone: 'err', text: res.error ?? 'Nothing was imported.' })
      } else {
        const skipNote = res.skipped.length ? ` (${res.skipped.length} skipped)` : ''
        setStatus({ tone: 'ok', text: `${res.summary}${skipNote}` })
        onImported?.(res)
      }
    } catch (e) {
      setStatus({ tone: 'err', text: e instanceof Error ? e.message : 'Import failed.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          className="shrink-0"
          disabled={busy !== null}
          onClick={() => void doExport()}
        >
          <Download className="h-3.5 w-3.5" /> {busy === 'export' ? 'Exporting…' : 'Export'}
        </Button>
        <Button
          variant="secondary"
          className="shrink-0"
          disabled={busy !== null}
          onClick={() => void doImport()}
        >
          <Upload className="h-3.5 w-3.5" /> {busy === 'import' ? 'Importing…' : 'Import'}
        </Button>
        {status && (
          <span className={`text-xs ${status.tone === 'ok' ? 'text-success' : 'text-danger'}`}>
            {status.text}
          </span>
        )}
      </div>
    </div>
  )
}
