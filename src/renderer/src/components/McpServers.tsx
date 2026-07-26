import { useEffect, useState } from 'react'
import { Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { McpServerView } from '@shared/api'
import type { McpServerConfig } from '@shared/mcp'
import { api } from '../lib/api'
import { Button, Input, Switch, Badge } from './ui'
import { ConfigBackup } from './ConfigBackup'

function configSummary(config: McpServerConfig): string {
  return config.type === 'remote' ? config.url : config.command.join(' ')
}

const MCP_STATUS_STYLES: Record<McpServerView['status'], string> = {
  connected: 'border-success/30 bg-success/15 text-success',
  error: 'border-danger/30 bg-danger/15 text-danger',
  disabled: 'text-text-muted'
}

/** List/add/toggle/reconnect/remove external MCP tool servers. Shared by Settings + the MCP page. */
export function McpServers({ showBackup = false }: { showBackup?: boolean } = {}): JSX.Element {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'local' | 'remote'>('local')
  const [value, setValue] = useState('')
  const [formErr, setFormErr] = useState('')

  const reload = async (): Promise<void> => {
    setServers(await api.mcp.list())
  }

  useEffect(() => {
    api.mcp.list().then((rows) => {
      setServers(rows)
      setLoading(false)
    })
  }, [])

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    setBusy(id)
    try {
      setServers(await api.mcp.setEnabled(id, enabled))
    } finally {
      setBusy(null)
    }
  }
  const reconnect = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      setServers(await api.mcp.reconnect(id))
    } finally {
      setBusy(null)
    }
  }
  const remove = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      setServers(await api.mcp.remove(id))
    } finally {
      setBusy(null)
    }
  }

  const submit = async (): Promise<void> => {
    const id = name.trim()
    if (!id) {
      setFormErr('Enter a name')
      return
    }
    if (servers.some((s) => s.id === id)) {
      setFormErr('A server with that name already exists')
      return
    }
    let config: McpServerConfig
    if (kind === 'remote') {
      const url = value.trim()
      if (!/^https?:\/\//i.test(url)) {
        setFormErr('Enter a valid http(s) URL')
        return
      }
      config = { type: 'remote', url }
    } else {
      const argv = value.trim().split(/\s+/).filter(Boolean)
      if (!argv.length) {
        setFormErr('Enter a command')
        return
      }
      config = { type: 'local', command: argv }
    }
    setBusy('__add__')
    setFormErr('')
    try {
      await api.mcp.upsert({ id, config, enabled: true })
      // Connect immediately so the user sees the live status / any error.
      setServers(await api.mcp.reconnect(id))
      setShowAdd(false)
      setName('')
      setValue('')
      setKind('local')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {loading ? (
        <p className="text-xs text-text-subtle">Loading…</p>
      ) : servers.length === 0 && !showAdd ? (
        <p className="text-xs text-text-muted">
          No MCP servers configured. Connect external tool servers (filesystem, GitHub, databases, …)
          to expand what the agent can do. Servers are also read from a workspace{' '}
          <code>.roxy/mcp.json</code>.
        </p>
      ) : (
        servers.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3.5"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-2">
              <Plug className="h-4 w-4 text-text-muted" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-text">{s.id}</span>
                <Badge className={MCP_STATUS_STYLES[s.status]}>
                  {s.status === 'connected'
                    ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`
                    : s.status}
                </Badge>
              </div>
              <p className="mt-0.5 truncate text-xs text-text-subtle" title={configSummary(s.config)}>
                {configSummary(s.config)}
              </p>
              {s.status === 'error' && s.error && (
                <p className="mt-0.5 truncate text-xs text-danger" title={s.error}>
                  {s.error}
                </p>
              )}
            </div>
            <Switch
              checked={s.enabled}
              disabled={busy === s.id}
              onChange={(v) => void toggle(s.id, v)}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === s.id || !s.enabled}
              onClick={() => void reconnect(s.id)}
              title="Reconnect"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === s.id}
              onClick={() => void remove(s.id)}
              title="Remove"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))
      )}

      {showAdd ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name (e.g. filesystem)"
              className="sm:w-48"
              spellCheck={false}
              autoComplete="off"
            />
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as 'local' | 'remote')}
              className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-text outline-none"
            >
              <option value="local">local (stdio)</option>
              <option value="remote">remote (http)</option>
            </select>
          </div>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              kind === 'remote'
                ? 'https://example.com/mcp'
                : 'npx -y @modelcontextprotocol/server-filesystem /path'
            }
            spellCheck={false}
            autoComplete="off"
          />
          {formErr && <p className="text-xs text-danger">{formErr}</p>}
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={busy === '__add__'} onClick={() => void submit()}>
              {busy === '__add__' ? 'Connecting…' : 'Add & connect'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowAdd(false)
                setFormErr('')
              }}
            >
              Cancel
            </Button>
            <span className="ml-auto text-[11px] text-text-subtle">
              Advanced (env, headers): use <code>.roxy/mcp.json</code>
            </span>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="press-scale flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface/40 p-3.5 text-sm text-text-muted hover:border-border-strong hover:bg-surface hover:text-text"
        >
          <Plus className="h-4 w-4" /> Add MCP server
        </button>
      )}
      {showBackup && (
        <div className="mt-1 border-t border-border pt-3">
          <ConfigBackup onImported={() => void reload()} />
        </div>
      )}
    </div>
  )
}
