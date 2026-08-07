import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ClipboardPaste, Copy, Plus, RotateCw, Search, Trash2, X } from 'lucide-react'
import type { CookieRow } from '@shared/api'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

/** A blank cookie scoped to the host you're looking at â€” what "Add" starts from. */
function blankCookie(host: string): CookieRow {
  return {
    name: '',
    value: '',
    domain: host,
    path: '/',
    secure: true,
    httpOnly: false,
    hostOnly: false,
    session: true,
    sameSite: 'lax',
    storeId: '0'
  }
}

/** Stable identity for a cookie â€” the tuple the jar itself keys on. */
function idOf(c: CookieRow): string {
  return `${c.domain}|${c.path}|${c.name}`
}

/** "in 3 days" / "expired" / "session" â€” the only part of a cookie people scan for. */
function expiryLabel(c: CookieRow): string {
  if (c.session || !c.expirationDate) return 'Session'
  const ms = c.expirationDate * 1000 - Date.now()
  if (ms <= 0) return 'Expired'
  const days = Math.round(ms / 86_400_000)
  if (days >= 1) return `${days}d`
  const hours = Math.round(ms / 3_600_000)
  return hours >= 1 ? `${hours}h` : `${Math.max(1, Math.round(ms / 60_000))}m`
}

/**
 * The cookie editor â€” Cookie-Editor's job, native to the Roxy browser.
 *
 * Used from two places: the browser window's own chrome (scoped to the active
 * tab's host, like the extension's popup) and Settings â†’ Browser (`scope`
 * omitted, so it shows the whole jar). Both drive the same partition, because
 * there is only one.
 */
export function CookiePanel({
  /** Host to scope to; omit for the entire jar. */
  host,
  /** Rendered top-right, next to the refresh control (the panel's close button). */
  action,
  className
}: {
  host?: string
  action?: React.ReactNode
  className?: string
}): JSX.Element {
  const [rows, setRows] = useState<CookieRow[]>([])
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setRows(await api.cookies.list(host ? `https://${host}/` : undefined))
    } finally {
      setBusy(false)
    }
  }, [host])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Notices are transient: they report the result of an action, and a stale
  // "Imported 12" sitting above a list you've since edited is just noise.
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.domain.toLowerCase().includes(q) ||
        c.value.toLowerCase().includes(q)
    )
  }, [rows, query])

  const save = async (row: CookieRow, original?: CookieRow): Promise<void> => {
    // Renaming or re-scoping writes a NEW cookie rather than moving one, so the
    // old one has to go explicitly or you'd silently end up with both.
    if (original && idOf(original) !== idOf(row) && original.name)
      await api.cookies.remove(original)
    const err = await api.cookies.set(row)
    if (err) setNote({ kind: 'err', text: err })
    else {
      setNote({ kind: 'ok', text: `Saved ${row.name}` })
      setOpenId(null)
    }
    await refresh()
  }

  const del = async (row: CookieRow): Promise<void> => {
    await api.cookies.remove(row)
    if (openId === idOf(row)) setOpenId(null)
    await refresh()
  }

  const copyAll = async (): Promise<void> => {
    // Cookie-Editor's export is a bare array, pretty-printed â€” match it exactly
    // so what lands on the clipboard pastes into that extension unchanged.
    await navigator.clipboard.writeText(JSON.stringify(shown, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const runImport = async (): Promise<void> => {
    try {
      const r = await api.cookies.importJson(importText)
      setNote(
        r.failed
          ? {
              kind: 'err',
              text: `Imported ${r.imported}, ${r.failed} failed: ${r.errors[0] ?? ''}`
            }
          : { kind: 'ok', text: `Imported ${r.imported} cookie${r.imported === 1 ? '' : 's'}.` }
      )
      if (r.imported) {
        setImportText('')
        setImporting(false)
      }
    } catch (e) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    }
    await refresh()
  }

  const clearAll = async (): Promise<void> => {
    const n = await api.cookies.clear(host)
    setNote({ kind: 'ok', text: `Deleted ${n} cookie${n === 1 ? '' : 's'}.` })
    await refresh()
  }

  return (
    <div className={cn('flex min-h-0 flex-col text-text', className)}>
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={host ? `Cookies for ${host}` : 'Search all cookies'}
            spellCheck={false}
            className="h-7 w-full rounded-md border border-border bg-surface-2 pl-7 pr-2 text-xs outline-none placeholder:text-text-subtle focus:border-accent"
          />
        </div>
        <IconBtn onClick={() => void refresh()} title="Refresh" busy={busy}>
          <RotateCw className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn
          onClick={() => {
            const c = blankCookie(host ?? '')
            setRows((r) => [c, ...r])
            setOpenId(idOf(c))
          }}
          title="Add cookie"
        >
          <Plus className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn onClick={() => void copyAll()} title="Copy as Cookie-Editor JSON">
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </IconBtn>
        <IconBtn onClick={() => setImporting((v) => !v)} title="Import JSON" active={importing}>
          <ClipboardPaste className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn
          onClick={() => void clearAll()}
          title={host ? `Delete all for ${host}` : 'Delete all'}
          danger
        >
          <Trash2 className="h-3.5 w-3.5" />
        </IconBtn>
        {action}
      </div>

      {importing && (
        <div className="shrink-0 border-b border-border bg-surface-2/40 p-2.5">
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder='Paste Cookie-Editor / EditThisCookie JSON â€” [{ "name": "session", "value": "â€¦", "domain": ".example.com" }]'
            spellCheck={false}
            rows={4}
            className="w-full resize-y rounded-md border border-border bg-surface p-2 font-mono text-[11px] outline-none placeholder:text-text-subtle focus:border-accent"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <SmallBtn onClick={() => setImporting(false)}>Cancel</SmallBtn>
            <SmallBtn onClick={() => void runImport()} primary disabled={!importText.trim()}>
              Import
            </SmallBtn>
          </div>
        </div>
      )}

      {note && (
        <div
          className={cn(
            'shrink-0 px-2.5 py-1.5 text-[11px]',
            note.kind === 'ok' ? 'text-success' : 'text-danger'
          )}
        >
          {note.text}
        </div>
      )}

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-text-subtle">
            {rows.length ? 'No cookies match that search.' : 'No cookies here yet.'}
          </p>
        ) : (
          shown.map((c) => {
            const id = idOf(c)
            return (
              <CookieItem
                key={id}
                cookie={c}
                open={openId === id}
                onToggle={() => setOpenId((v) => (v === id ? null : id))}
                onSave={(next) => void save(next, c)}
                onDelete={() => void del(c)}
              />
            )
          })
        )}
      </div>
    </div>
  )
}

/** One row: a summary line that expands into the full editable field set. */
function CookieItem({
  cookie,
  open,
  onToggle,
  onSave,
  onDelete
}: {
  cookie: CookieRow
  open: boolean
  onToggle: () => void
  onSave: (next: CookieRow) => void
  onDelete: () => void
}): JSX.Element {
  const [draft, setDraft] = useState<CookieRow>(cookie)
  const nameRef = useRef<HTMLInputElement>(null)

  // Re-seed when the underlying cookie changes (a refresh landed) but never
  // while the editor is open, or a background refresh would wipe your typing.
  useEffect(() => {
    if (!open) setDraft(cookie)
  }, [cookie, open])

  useEffect(() => {
    if (open && !cookie.name) nameRef.current?.focus()
  }, [open, cookie.name])

  const patch = (p: Partial<CookieRow>): void => setDraft((d) => ({ ...d, ...p }))

  return (
    <div className="border-b border-border/60">
      <div
        onClick={onToggle}
        className="flex cursor-default items-center gap-2 px-2.5 py-1.5 hover:bg-surface-2/60"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text">
          {cookie.name || <span className="text-text-subtle italic">new cookie</span>}
        </span>
        <span className="min-w-0 max-w-[45%] flex-1 truncate font-mono text-[11px] text-text-subtle">
          {cookie.value}
        </span>
        <span className="shrink-0 text-[10px] text-text-subtle">{expiryLabel(cookie)}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="Delete cookie"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-subtle hover:bg-danger/15 hover:text-danger"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {open && (
        <div className="grid gap-2 bg-surface-2/40 px-2.5 pb-2.5 pt-2 sm:grid-cols-2">
          <Field label="Name">
            <input
              ref={nameRef}
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              className={fieldCls}
            />
          </Field>
          <Field label="Domain">
            <input
              value={draft.domain}
              onChange={(e) => patch({ domain: e.target.value })}
              className={fieldCls}
            />
          </Field>
          <Field label="Value" wide>
            <textarea
              value={draft.value}
              onChange={(e) => patch({ value: e.target.value })}
              rows={2}
              className={cn(fieldCls, 'resize-y')}
            />
          </Field>
          <Field label="Path">
            <input
              value={draft.path}
              onChange={(e) => patch({ path: e.target.value })}
              className={fieldCls}
            />
          </Field>
          <Field label="SameSite">
            <select
              value={draft.sameSite}
              onChange={(e) => patch({ sameSite: e.target.value as CookieRow['sameSite'] })}
              className={fieldCls}
            >
              <option value="unspecified">Unspecified</option>
              <option value="lax">Lax</option>
              <option value="strict">Strict</option>
              <option value="no_restriction">None</option>
            </select>
          </Field>
          <Field label="Expires" wide>
            <div className="flex items-center gap-2">
              <input
                type="datetime-local"
                disabled={draft.session}
                value={
                  draft.expirationDate
                    ? new Date(draft.expirationDate * 1000).toISOString().slice(0, 16)
                    : ''
                }
                onChange={(e) => {
                  const t = Date.parse(e.target.value)
                  patch({ expirationDate: Number.isNaN(t) ? undefined : t / 1000 })
                }}
                className={cn(fieldCls, 'flex-1 disabled:opacity-40')}
              />
              <Toggle
                label="Session"
                checked={draft.session}
                onChange={(v) => patch({ session: v })}
              />
            </div>
          </Field>
          <div className="col-span-full flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Toggle label="Secure" checked={draft.secure} onChange={(v) => patch({ secure: v })} />
            <Toggle
              label="HttpOnly"
              checked={draft.httpOnly}
              onChange={(v) => patch({ httpOnly: v })}
            />
            <Toggle
              label="Host only"
              checked={draft.hostOnly}
              onChange={(v) => patch({ hostOnly: v })}
            />
            <div className="ml-auto flex gap-1.5">
              <SmallBtn onClick={onToggle}>Cancel</SmallBtn>
              <SmallBtn
                onClick={() => onSave(draft)}
                primary
                disabled={!draft.name || !draft.domain}
              >
                Save
              </SmallBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const fieldCls =
  'w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] text-text outline-none focus:border-accent'

function Field({
  label,
  wide,
  children
}: {
  label: string
  wide?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className={cn('flex flex-col gap-1', wide && 'sm:col-span-2')}>
      <span className="text-[10px] uppercase tracking-wide text-text-subtle">{label}</span>
      {children}
    </label>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <label className="flex cursor-default items-center gap-1.5 text-[11px] text-text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  busy,
  active,
  danger
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  busy?: boolean
  active?: boolean
  danger?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'press-scale flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text',
        active && 'bg-surface-2 text-text',
        danger && 'hover:bg-danger/15 hover:text-danger',
        busy && 'animate-pulse'
      )}
    >
      {children}
    </button>
  )
}

function SmallBtn({
  children,
  onClick,
  primary,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  primary?: boolean
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'press-scale rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40',
        primary
          ? 'bg-white text-black hover:bg-white/90'
          : 'border border-border text-text-muted hover:bg-surface-2 hover:text-text'
      )}
    >
      {children}
    </button>
  )
}
