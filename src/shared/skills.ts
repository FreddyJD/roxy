import type { SkillDef } from './types'

/**
 * Two things live in this module:
 *
 *  1. The static "capabilities" catalog (`SKILLS`) rendered on the onboarding +
 *     Skills pages — aspirational integrations that light up as they land.
 *
 *  2. The **skills runtime** primitives (pure, dependency-free so they're testable
 *     in smoke:shared): parsing a `SKILL.md`'s frontmatter, formatting the
 *     discovered-skills block for the system prompt, and rendering the `skill`
 *     tool's output. The filesystem discovery + tool execution that use these live
 *     in `src/main/services/skills.ts`. Mirrors opencode's `skill/` runtime
 *     (github.com/sst/opencode, MIT), rebranded + trimmed to a dep-free core.
 */

/**
 * Featured capabilities shown on the onboarding "Skills" step. Some are live today
 * (they map onto Roxy's built-in tools — see the "Skills & Tools" page for the full
 * tool list); the rest are integrations on the roadmap, marked `coming-soon`.
 */
export const SKILLS: SkillDef[] = [
  {
    id: 'browser',
    name: 'Browser',
    description: 'Let Roxy browse and operate the web.',
    status: 'available',
    icon: 'globe',
    category: 'Web'
  },
  {
    id: 'github-cli',
    name: 'GitHub CLI',
    description: 'Manage repos, issues, and PRs via gh.',
    status: 'coming-soon',
    icon: 'git-branch',
    category: 'Developer'
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Read and send email from Gmail.',
    status: 'coming-soon',
    icon: 'mail',
    category: 'Productivity'
  },
  {
    id: 'outlook',
    name: 'Outlook',
    description: 'Read and send email from Outlook.',
    status: 'coming-soon',
    icon: 'inbox',
    category: 'Productivity'
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write local files.',
    status: 'available',
    icon: 'folder',
    category: 'System'
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'Run shell commands in a sandbox.',
    status: 'available',
    icon: 'terminal',
    category: 'System'
  },
  {
    id: 'web-search',
    name: 'Web Search',
    description: 'Search the web for fresh context.',
    status: 'available',
    icon: 'search',
    category: 'Web'
  },
  {
    id: 'code-interpreter',
    name: 'Code Interpreter',
    description: 'Execute code and return results.',
    status: 'coming-soon',
    icon: 'code',
    category: 'Developer'
  }
]

// ===========================================================================
// Skills runtime (SKILL.md discovery) — pure primitives
// ===========================================================================

/** The tool name the model calls to load a skill on demand. */
export const SKILL_TOOL_NAME = 'skill'

/** The `skill` tool's description (shown to the model in its tool list). */
export const SKILL_TOOL_DESCRIPTION = [
  'Load a specialized skill when the task at hand matches one of the available skills listed in the system prompt.',
  '',
  "Use this to inject the skill's full instructions and resources into the conversation. The output may contain detailed workflow guidance plus references to scripts and files in the skill's own directory.",
  '',
  'The `name` must exactly match one of the available skills.'
].join('\n')

/** How many companion files (besides SKILL.md) to sample into the tool output. */
export const SKILL_FILE_SAMPLE_LIMIT = 10

/** A discovered skill: a `SKILL.md` (or bare `<name>.md`) with frontmatter + body. */
export interface SkillInfo {
  /** Unique key — the frontmatter `name`, else the folder/file basename. */
  name: string
  /** One-line summary from frontmatter; advertised to the model. */
  description?: string
  /** Absolute path to the source markdown file. */
  location: string
  /** The markdown body with the frontmatter block stripped. */
  content: string
  /** Where it was found — a project source outranks a global one on a name clash. */
  source: 'workspace' | 'global'
}

const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Parse a `SKILL.md`'s leading YAML frontmatter. Intentionally minimal + robust:
 * we only need top-level scalar `key: value` pairs (name, description), so we
 * read those line-by-line and ignore nested/list values (e.g. a `references:`
 * list) rather than pulling in a YAML dependency. Returns the raw string map plus
 * the body with the frontmatter removed. No frontmatter → empty map + full text.
 */
export function parseSkillFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { data: {}, body: raw.replace(/^\uFEFF/, '') }
  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    // Skip blank lines, comments, and list items / nested block content.
    if (!line.trim() || /^\s*#/.test(line) || /^\s*-\s/.test(line) || /^\s+\S/.test(line)) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (!key) continue
    let val = line.slice(idx + 1).trim()
    // A block/list scalar (`key:` or `key: |`) has no inline value we can use.
    if (val === '' || val === '|' || val === '>') continue
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1)
    }
    data[key] = val
  }
  return { data, body: raw.slice(m[0].length) }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The system-prompt block that advertises the discovered skills, mirroring
 * opencode's verbose format (models ingest the verbose XML shape better here than
 * a terse list). Returns `undefined` when there are no skills so the caller can
 * omit the section entirely.
 */
export function describeSkillsForPrompt(skills: SkillInfo[]): string | undefined {
  if (!skills.length) return undefined
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name))
  return [
    'Skills provide specialized instructions and workflows for specific tasks.',
    `Use the ${SKILL_TOOL_NAME} tool to load a skill when a task matches its description — it injects that skill's full instructions on demand.`,
    '<available_skills>',
    ...sorted.flatMap((s) => [
      '  <skill>',
      `    <name>${escapeXml(s.name)}</name>`,
      ...(s.description ? [`    <description>${escapeXml(s.description)}</description>`] : []),
      `    <location>${escapeXml(s.location)}</location>`,
      '  </skill>'
    ]),
    '</available_skills>'
  ].join('\n')
}

/**
 * Render the `skill` tool's output: the skill's instructions, its base directory
 * (so relative `scripts/`, `reference/` paths resolve), and a sampled list of the
 * companion files that ship alongside it. Mirrors opencode's `toModelOutput`.
 */
export function renderSkillContent(
  skill: Pick<SkillInfo, 'name' | 'content'>,
  directory: string,
  files: string[]
): string {
  const lines = [
    `<skill_content name="${escapeXml(skill.name)}">`,
    `# Skill: ${skill.name}`,
    '',
    skill.content.trim(),
    '',
    `Base directory for this skill: ${directory}`,
    'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.'
  ]
  if (files.length) {
    lines.push(
      'Note: the file list below is sampled and may be incomplete.',
      '',
      '<skill_files>',
      ...files.map((f) => `<file>${escapeXml(f)}</file>`),
      '</skill_files>'
    )
  }
  lines.push('</skill_content>')
  return lines.join('\n')
}

// ===========================================================================
// Skill authoring (SKILL.md serialization) — pure primitives
// ===========================================================================

/** Valid skill name: starts alnum, then alnum/dot/dash/underscore. No slashes/spaces. */
export const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * Whether a name is safe to use as a skill id + on-disk folder. Rejects path
 * separators, `..`, spaces, and anything that isn't a plain filename token — so a
 * created skill can never write outside its skills root.
 */
export function isValidSkillName(name: string): boolean {
  const n = (name ?? '').trim()
  return n.length > 0 && n.length <= 64 && SKILL_NAME_RE.test(n) && !n.includes('..')
}

/**
 * Serialize a frontmatter scalar so it round-trips through `parseSkillFrontmatter`.
 * The parser is intentionally minimal (it strips one layer of surrounding quotes
 * and splits on the first colon), so we only quote when a bare value could be
 * misread — an empty/leading-special/edge-whitespace value — and we swap any inner
 * double quotes for single quotes so the outer quotes survive the round-trip.
 */
function frontmatterScalar(value: string): string {
  const v = value.replace(/\r?\n/g, ' ').trim()
  const needsQuote = v === '' || /^[#\-|>'"]/.test(v) || /^\s|\s$/.test(v)
  return needsQuote ? `"${v.replace(/"/g, "'")}"` : v
}

/**
 * Render a `SKILL.md` document from a name, optional one-line description, and a
 * markdown body. The output parses back cleanly via `parseSkillFrontmatter`
 * (name/description recovered, body preserved) — this is the authoring inverse of
 * discovery, used by the `skill_manage` tool and the Skills page.
 */
export function serializeSkillMarkdown(
  name: string,
  description: string | undefined,
  body: string
): string {
  const lines = ['---', `name: ${frontmatterScalar(name)}`]
  const desc = description?.replace(/\r?\n/g, ' ').trim()
  if (desc) lines.push(`description: ${frontmatterScalar(desc)}`)
  lines.push('---', '')
  const trimmedBody = body.replace(/^\s+/, '').replace(/\s+$/, '')
  return lines.join('\n') + (trimmedBody ? trimmedBody + '\n' : '')
}

// ---------------------------------------------------------------------------
// Remote source resolution (installing a skill like `npx skills add <src>`)
// ---------------------------------------------------------------------------

/**
 * A skill install source, resolved from a user/agent-supplied string into a shape
 * the installer knows how to fetch. Mirrors what `npx skills add` accepts, scoped
 * to the sources we can fetch without shelling out to git: GitHub (the ecosystem's
 * home — `owner/repo` shorthand, repo URLs, and `/tree|/blob` deep links) plus any
 * direct `https://…/SKILL.md`. Anything else (GitLab, `git@…`, local paths) is
 * reported as `unsupported` with a friendly reason rather than throwing.
 */
export type SkillSource =
  | { kind: 'github-repo'; owner: string; repo: string; ref?: string }
  | { kind: 'github-dir'; owner: string; repo: string; path: string; ref?: string }
  | { kind: 'github-file'; owner: string; repo: string; path: string; ref?: string }
  | { kind: 'raw-md'; url: string }
  | { kind: 'unsupported'; input: string; reason: string }

/** A GitHub owner or repo token — conservative, and never path-traversing. */
const GH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

function safeSegment(s: string): boolean {
  return GH_SEGMENT_RE.test(s) && !s.includes('..')
}

/** Strip a trailing `.git` and surrounding whitespace/slashes from a token. */
function trimRepo(s: string): string {
  return s
    .trim()
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
}

function unsupported(input: string, reason: string): SkillSource {
  return { kind: 'unsupported', input, reason }
}

/**
 * Classify a skill install source. Pure + dependency-free (uses only the global
 * `URL`), so it's unit-tested in smoke:shared and safe to import from anywhere.
 *
 * Accepted:
 *  - `owner/repo` (GitHub shorthand), optionally `owner/repo/sub/dir` (a path in
 *    the default branch)
 *  - `https://github.com/owner/repo`
 *  - `https://github.com/owner/repo/tree/<ref>/<path>` (a directory)
 *  - `https://github.com/owner/repo/blob/<ref>/<path>` (a file, usually SKILL.md)
 *  - `https://raw.githubusercontent.com/owner/repo/<ref>/<path>.md` and any other
 *    `https://…/*.md` (a direct SKILL.md)
 */
export function resolveSkillSource(input: string): SkillSource {
  const raw = (input ?? '').trim()
  if (!raw) return unsupported(input, 'Provide a GitHub repo (owner/repo or a URL) or a direct SKILL.md URL.')

  if (/^https?:\/\//i.test(raw)) return resolveUrlSource(raw)

  // Bare local paths are not fetched (no git shell-out); steer to a supported form.
  if (/^[./~]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return unsupported(raw, 'Local paths are not supported here — point to a GitHub repo (owner/repo) or a SKILL.md URL.')
  }
  // `git@github.com:owner/repo.git` and other SCP-like git URLs.
  if (/^[\w.-]+@[\w.-]+:/.test(raw)) {
    const m = /^git@github\.com:([^/]+)\/(.+)$/i.exec(raw)
    if (m && safeSegment(m[1]) && safeSegment(trimRepo(m[2]))) {
      return { kind: 'github-repo', owner: m[1], repo: trimRepo(m[2]) }
    }
    return unsupported(raw, 'Only GitHub is supported for git URLs — use github.com/owner/repo or the owner/repo shorthand.')
  }

  // Shorthand: owner/repo (+ optional path within the default branch).
  const segs = raw.split('/').filter(Boolean)
  if (segs.length >= 2 && safeSegment(segs[0]) && safeSegment(trimRepo(segs[1]))) {
    const owner = segs[0]
    const repo = trimRepo(segs[1])
    if (segs.length === 2) return { kind: 'github-repo', owner, repo }
    const rest = segs.slice(2)
    if (!rest.every(safeSegment)) return unsupported(raw, 'Invalid path in the repo source.')
    const path = rest.join('/')
    return /\.md$/i.test(path)
      ? { kind: 'github-file', owner, repo, path }
      : { kind: 'github-dir', owner, repo, path }
  }

  return unsupported(raw, 'Unrecognized source. Use owner/repo, a github.com URL, or a direct https URL to a SKILL.md.')
}

function resolveUrlSource(raw: string): SkillSource {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return unsupported(raw, 'Malformed URL.')
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const segs = u.pathname.split('/').filter(Boolean)

  if (host === 'github.com') {
    if (segs.length < 2 || !safeSegment(segs[0]) || !safeSegment(trimRepo(segs[1]))) {
      return unsupported(raw, 'A GitHub URL needs at least github.com/owner/repo.')
    }
    const owner = segs[0]
    const repo = trimRepo(segs[1])
    if (segs.length === 2) return { kind: 'github-repo', owner, repo }
    const marker = segs[2] // 'tree' | 'blob' | something else
    if (marker === 'tree' || marker === 'blob') {
      const ref = segs[3]
      const pathSegs = segs.slice(4)
      if (!ref || !safeSegment(ref)) return unsupported(raw, 'Could not read the git ref from the GitHub URL.')
      if (!pathSegs.every(safeSegment)) return unsupported(raw, 'Invalid path in the GitHub URL.')
      const path = pathSegs.join('/')
      if (!path) return { kind: 'github-repo', owner, repo, ref }
      return marker === 'blob' || /\.md$/i.test(path)
        ? { kind: 'github-file', owner, repo, path, ref }
        : { kind: 'github-dir', owner, repo, path, ref }
    }
    // e.g. github.com/owner/repo/skills/foo — treat the tail as a default-branch path.
    const pathSegs = segs.slice(2)
    if (!pathSegs.every(safeSegment)) return unsupported(raw, 'Invalid path in the GitHub URL.')
    const path = pathSegs.join('/')
    return /\.md$/i.test(path)
      ? { kind: 'github-file', owner, repo, path }
      : { kind: 'github-dir', owner, repo, path }
  }

  // Any direct link to a markdown file (raw.githubusercontent.com, gists, docs …).
  if (/\.md$/i.test(u.pathname)) return { kind: 'raw-md', url: raw }

  if (host === 'raw.githubusercontent.com') {
    return unsupported(raw, 'A raw GitHub URL must point directly at a SKILL.md file.')
  }
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) {
    return unsupported(raw, 'GitLab is not supported yet — use a GitHub repo or a direct SKILL.md URL.')
  }
  return unsupported(raw, `Unsupported source host "${host}". Use GitHub or a direct https URL to a SKILL.md.`)
}

/**
 * Best-effort turn a raw name (frontmatter `name`, a folder, or a filename) into a
 * valid skill id: lowercased, non-token chars collapsed to dashes, leading
 * non-alphanumerics trimmed, `..` neutralized, capped at 64. Returns null when
 * nothing valid remains (the installer then skips that entry). Pure/testable.
 */
export function sanitizeSkillName(rawName: string): string | null {
  let n = (rawName ?? '').trim().toLowerCase()
  n = n.replace(/[^a-z0-9._-]+/g, '-') // collapse runs of invalid chars to a single dash
  n = n.replace(/\.{2,}/g, '.') // no `..`
  n = n.replace(/^[^a-z0-9]+/, '') // must start with an alphanumeric (SKILL_NAME_RE)
  n = n.replace(/[-_.]+$/, '') // tidy trailing separators
  n = n.slice(0, 64).replace(/[-_.]+$/, '')
  return isValidSkillName(n) ? n : null
}
