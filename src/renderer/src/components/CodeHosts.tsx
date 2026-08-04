/**
 * Settings > Code hosts.
 *
 * This section is deliberately NOT part of the AI provider list, and the
 * distinction is worth being explicit about because one vendor appears in both:
 *
 *   Providers  -> who runs the MODEL.       GitHub Copilot lives here.
 *   Code hosts -> where the CODE lives.     github.com lives here.
 *
 * They are different accounts with different tokens and different scopes.
 * Signing into Copilot must never imply access to your repositories, and
 * merging the two lists would quietly imply exactly that.
 *
 * The second thing to notice: there is no "Connect" button, because there is
 * nothing for Roxy to connect. Credentials belong to git's credential helper
 * (Git Credential Manager and friends), which already handles Microsoft
 * Account/Entra sign-in, MFA, and — the part that matters for short-lived
 * Azure DevOps tokens — silent refresh. Roxy reads what git already has.
 *
 * So this is a STATUS view, not a login form. It renders what is true right
 * now, which means a token that expired overnight shows as disconnected with
 * no bookkeeping on Roxy's side.
 */
import { useEffect, useState } from 'react'
import type { ForgeHostView, ForgeKind } from '@shared/forge'
import { FORGE_NAMES } from '@shared/forge'
import { api } from '../lib/api'

const KINDS: ForgeKind[] = ['github', 'azure-devops', 'gitlab', 'bitbucket']

export function CodeHosts(): JSX.Element {
  const [hosts, setHosts] = useState<ForgeHostView[]>([])
  const [loading, setLoading] = useState(true)

  const load = async (): Promise<void> => {
    try {
      setHosts(await api.forge.listHosts())
    } catch {
      // A failure here means git is missing or unreadable; an empty list is the
      // honest rendering of that, and the empty state below explains it.
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const choose = async (host: string, kind: ForgeKind | null): Promise<void> => {
    await api.forge.setHostKind(host, kind)
    await load()
  }

  return (
    <div className="flex flex-col gap-3 sq sq-xl sq-ring rounded-xl border border-border bg-surface p-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text">Pull requests</div>
        <p className="mt-0.5 text-xs text-text-muted">
          Roxy reads pull request state for your branches from whichever host your{' '}
          <code className="text-text-subtle">origin</code> points at. It uses the credentials git
          already has, so there is nothing to sign into here — if{' '}
          <code className="text-text-subtle">git push</code> works, this works.
        </p>
      </div>

      {loading ? null : hosts.length === 0 ? (
        <p className="text-xs text-text-subtle">
          No git remotes yet. Open a project with an <code>origin</code> and its host appears here.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {hosts.map((h) => (
            <HostRow key={h.host} host={h} onChoose={choose} />
          ))}
        </div>
      )}
    </div>
  )
}

function HostRow({
  host,
  onChoose
}: {
  host: ForgeHostView
  onChoose: (host: string, kind: ForgeKind | null) => Promise<void>
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 sq sq-lg rounded-lg px-2 py-2 transition hover:bg-white/5">
      <StatusDot host={host} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-text">{host.host}</div>
        <div className="truncate text-[11px] text-text-subtle">
          {host.kind ? FORGE_NAMES[host.kind] : 'Unrecognised host'}
          {host.username ? ` · ${host.username}` : ''}
          {host.repos.length
            ? ` · ${host.repos.length} repo${host.repos.length === 1 ? '' : 's'}`
            : ''}
        </div>
      </div>

      {/* An unrecognised domain is the ONE case that needs input: we can't tell
          what `git.mycorp.com` runs, and guessing would fire authenticated
          requests at an unrelated server. Asked once, then remembered. */}
      {host.kind === null ? (
        <select
          value=""
          onChange={(e) => void onChoose(host.host, (e.target.value || null) as ForgeKind | null)}
          className="shrink-0 sq sq-lg sq-ring rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs text-text"
        >
          <option value="">Which host?</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {FORGE_NAMES[k]}
            </option>
          ))}
        </select>
      ) : (
        <span className="shrink-0 text-[11px] text-text-subtle">
          {host.connected ? 'Connected' : 'No credential'}
        </span>
      )}
    </div>
  )
}

/**
 * Green only when we can actually talk to the host. "Unrecognised" is amber
 * rather than red because nothing is broken — we just need one answer from the
 * user.
 */
function StatusDot({ host }: { host: ForgeHostView }): JSX.Element {
  const cls =
    host.kind === null ? 'bg-warning' : host.connected ? 'bg-success' : 'bg-text-subtle/70'
  const title =
    host.kind === null
      ? 'Roxy needs to know which software this host runs'
      : host.connected
        ? 'git has a credential for this host'
        : 'No stored credential — run any git command against this host to create one'
  return <span className={`h-2 w-2 shrink-0 rounded-full ${cls}`} title={title} />
}
