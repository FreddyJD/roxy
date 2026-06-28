import { useEffect, useState } from 'react'
import { INTEGRATIONS } from '@shared/integrations'
import type { IntegrationConnection } from '@shared/types'
import { api } from '../../lib/api'
import { CatalogIcon } from '../../lib/icons'
import { Badge, Switch } from '../../components/ui'

export function IntegrationsStep(): JSX.Element {
  const [state, setState] = useState<Record<string, boolean>>({})

  useEffect(() => {
    api.integrations.list().then((rows: IntegrationConnection[]) => {
      setState(Object.fromEntries(rows.map((r) => [r.id, r.enabled])))
    })
  }, [])

  const toggle = async (id: string, value: boolean): Promise<void> => {
    setState((s) => ({ ...s, [id]: value }))
    await api.integrations.setEnabled(id, value)
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Connect your chats <span className="text-text-subtle">(optional)</span>
      </h1>
      <p className="mt-2 text-sm text-text-muted">
        Reach Roxy from your favorite messengers — OpenClaw-style. Flip one on and we&apos;ll set it
        up when it ships.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {INTEGRATIONS.map((it) => (
          <div
            key={it.id}
            className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4"
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{ backgroundColor: `${it.accent}1a`, color: it.accent }}
            >
              <CatalogIcon name={it.icon} className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text">{it.name}</span>
                {it.status === 'coming-soon' && <Badge>Soon</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-text-muted">{it.description}</p>
            </div>
            <Switch checked={!!state[it.id]} onChange={(v) => toggle(it.id, v)} />
          </div>
        ))}
      </div>
    </div>
  )
}
