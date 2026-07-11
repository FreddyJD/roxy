import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, FileText, FolderGit2, Home, Pencil, Plus, RefreshCw, Trash2, Wrench } from 'lucide-react'
import { TOOLS, TOOL_CATEGORIES, type ToolDef } from '@shared/tools'
import type { SkillView } from '@shared/api'
import { api } from '../lib/api'
import { Badge, Button, Input, Textarea } from '../components/ui'
import { PageShell } from '../components/PageShell'
import { ConfigBackup } from '../components/ConfigBackup'

export default function Skills(): JSX.Element {
  const navigate = useNavigate()

  return (
    <PageShell
      title="Skills & Tools"
      subtitle="Specialized SKILL.md workflows Roxy loads on demand, plus the built-in tools it can call."
      onBack={() => navigate('/')}
    >
      <div className="flex flex-col gap-9">
        <DiscoveredSkills />
        <BuiltInTools />
      </div>
    </PageShell>
  )
}

/** The real tools Roxy's agent can call, grouped by category (see `@shared/tools`). */
function BuiltInTools(): JSX.Element {
  return (
    <div className="flex flex-col gap-7">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Built-in tools
        </h2>
        <p className="mt-1 text-xs text-text-muted">
          The {TOOLS.length} tools Roxy&apos;s agent can call directly. Plan mode is limited to the
          read-only subset; <Badge>writes</Badge> marks a tool that can change files or state.
        </p>
      </div>
      {TOOL_CATEGORIES.map((category) => (
        <section key={category}>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
            {category}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TOOLS.filter((t) => t.category === category).map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** Editor draft for creating or editing a skill. */
interface SkillDraft {
  mode: 'create' | 'edit'
  name: string
  description: string
  body: string
}

/** The real, filesystem-discovered skills (SKILL.md files under the user's global roots). */
function DiscoveredSkills(): JSX.Element {
  const [skills, setSkills] = useState<SkillView[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    api.skills
      .list()
      .then(setSkills)
      .finally(() => setLoading(false))
  }, [])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      setSkills(await api.skills.refresh())
    } finally {
      setRefreshing(false)
    }
  }

  const startEdit = async (name: string): Promise<void> => {
    const detail = await api.skills.read(name)
    setDraft({
      mode: 'edit',
      name,
      description: detail?.description ?? '',
      body: detail?.body ?? ''
    })
  }

  const remove = async (name: string): Promise<void> => {
    setSkills(await api.skills.remove(name))
    if (draft?.name === name) setDraft(null)
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Discovered skills
        </h2>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setInstalling((v) => !v)
              setDraft(null)
            }}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Add from URL
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft({ mode: 'create', name: '', description: '', body: '' })
              setInstalling(false)
            }}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            New skill
          </Button>
          <Button size="sm" variant="ghost" onClick={refresh} disabled={refreshing} className="gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Rescan
          </Button>
          <ConfigBackup onImported={() => void refresh()} />
        </div>
      </div>

      <p className="mb-3 text-xs text-text-muted">
        Skills are reusable <code className="text-text-subtle">SKILL.md</code> playbooks the model can
        load on demand. Skills created or installed here are global (saved under{' '}
        <code className="text-text-subtle">~/.roxy/skills</code>) and available in every workspace.
      </p>

      {installing && (
        <InstallFromUrl
          onCancel={() => setInstalling(false)}
          onInstalled={(list) => {
            setSkills(list)
            setInstalling(false)
          }}
        />
      )}

      {draft && (
        <SkillEditor
          draft={draft}
          existing={skills}
          onCancel={() => setDraft(null)}
          onSaved={(list) => {
            setSkills(list)
            setDraft(null)
          }}
        />
      )}

      {loading ? (
        <p className="text-xs text-text-muted">Scanning for skills…</p>
      ) : skills.length === 0 ? (
        !draft && !installing && <EmptySkills />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {skills.map((skill) => (
            <DiscoveredSkillCard
              key={skill.location}
              skill={skill}
              onEdit={() => startEdit(skill.name)}
              onRemove={() => remove(skill.name)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * "Add from URL" — Roxy's in-app `npx skills add`. Paste a GitHub repo (owner/repo
 * or a URL) or a direct SKILL.md link; it fetches and installs every skill it finds
 * into the global skills root.
 */
function InstallFromUrl({
  onCancel,
  onInstalled
}: {
  onCancel: () => void
  onInstalled: (list: SkillView[]) => void
}): JSX.Element {
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string[] | null>(null)

  const install = async (): Promise<void> => {
    const src = source.trim()
    if (!src) {
      setError('Paste a GitHub repo (owner/repo) or a SKILL.md URL.')
      return
    }
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const res = await api.skills.install(src)
      if (!res.ok) {
        setError(res.error ?? 'Nothing was installed.')
        return
      }
      setDone(res.installed.map((s) => s.name))
      onInstalled(res.skills)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface p-4">
      <h3 className="mb-1 text-sm font-medium text-text">Add a skill from a URL</h3>
      <p className="mb-3 text-xs text-text-muted">
        A GitHub <code className="text-text-subtle">owner/repo</code>, a github.com repo/tree/blob URL,
        or a direct <code className="text-text-subtle">https://…/SKILL.md</code>. Installs every skill
        it finds (repo root and <code className="text-text-subtle">skills/</code>).
      </p>
      <div className="space-y-3">
        <Input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void install()
          }}
          placeholder="e.g. vercel-labs/agent-skills"
          autoFocus
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        {done && (
          <p className="text-xs text-success">
            Installed {done.length} skill{done.length === 1 ? '' : 's'}: {done.join(', ')}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          <Button size="sm" onClick={install} disabled={busy} className="gap-1.5">
            {busy ? (
              'Installing…'
            ) : (
              <>
                <Download className="h-3.5 w-3.5" />
                Install
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Create / edit form for a global skill. */
function SkillEditor({
  draft,
  existing,
  onCancel,
  onSaved
}: {
  draft: SkillDraft
  existing: SkillView[]
  onCancel: () => void
  onSaved: (list: SkillView[]) => void
}): JSX.Element {
  const [name, setName] = useState(draft.name)
  const [description, setDescription] = useState(draft.description)
  const [body, setBody] = useState(draft.body)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isEdit = draft.mode === 'edit'

  const save = async (): Promise<void> => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('A skill needs a name.')
      return
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmedName)) {
      setError('Name may only contain letters, numbers, dots, dashes and underscores.')
      return
    }
    if (
      !isEdit &&
      existing.some((s) => s.name.toLowerCase() === trimmedName.toLowerCase())
    ) {
      setError('A skill with that name already exists.')
      return
    }
    if (!body.trim()) {
      setError('Add some instructions in the body.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const input = { name: trimmedName, description: description.trim() || undefined, body }
      const list = isEdit ? await api.skills.update(input) : await api.skills.create(input)
      onSaved(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the skill.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface p-4">
      <h3 className="mb-3 text-sm font-medium text-text">
        {isEdit ? `Edit “${draft.name}”` : 'New skill'}
      </h3>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-text-muted">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isEdit}
            placeholder="e.g. release-notes"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Description</label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One line the model uses to decide when to load this skill"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted">Instructions (Markdown)</label>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            placeholder="Step-by-step guidance the model pulls in when it loads this skill…"
            className="font-mono text-xs"
          />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create skill'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function DiscoveredSkillCard({
  skill,
  onEdit,
  onRemove
}: {
  skill: SkillView
  onEdit: () => void
  onRemove: () => void
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="group flex items-start gap-3 rounded-xl border border-border bg-surface p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-text-muted">
        <FileText className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text">{skill.name}</span>
          <Badge>
            <span className="inline-flex items-center gap-1">
              {skill.source === 'workspace' ? (
                <FolderGit2 className="h-3 w-3" />
              ) : (
                <Home className="h-3 w-3" />
              )}
              {skill.source}
            </span>
          </Badge>
        </div>
        {skill.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">{skill.description}</p>
        )}
        <p className="mt-1 truncate text-[11px] text-text-subtle" title={skill.location}>
          {skill.location}
        </p>
        {confirming && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-danger">Delete this skill?</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={onRemove}>
              Delete
            </Button>
          </div>
        )}
      </div>
      {!confirming && (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
          <button
            onClick={onEdit}
            title="Edit"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-text"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setConfirming(true)}
            title="Delete"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

function EmptySkills(): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface/50 p-5 text-xs text-text-muted">
      <p className="text-text">No skills discovered yet.</p>
      <p className="mt-2">
        A skill is a <code className="text-text">SKILL.md</code> file whose frontmatter{' '}
        <code className="text-text">name</code> + <code className="text-text">description</code> tell
        Roxy when to load it. Roxy discovers them from:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <code className="text-text">~/.roxy/skills/&lt;name&gt;/SKILL.md</code> — your global skills
        </li>
        <li>
          <code className="text-text">.roxy/skills/&lt;name&gt;/SKILL.md</code> — inside a project
          (also reads <code className="text-text">.claude/skills</code> and{' '}
          <code className="text-text">.agents/skills</code>)
        </li>
      </ul>
      <p className="mt-2">
        When a task matches, Roxy calls the <code className="text-text">skill</code> tool to pull that
        skill&apos;s full instructions into context.
      </p>
    </div>
  )
}

function ToolCard({ tool }: { tool: ToolDef }): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-text-muted">
        <Wrench className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="text-sm font-medium text-text">{tool.name}</code>
          {tool.mutates && <Badge>writes</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-text-muted">{tool.description}</p>
      </div>
    </div>
  )
}
