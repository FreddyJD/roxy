/**
 * The built-in tool catalog: the name, one-line summary, and category of every
 * tool Roxy's harness offers the model. This is the *user-facing* view, rendered
 * on the "Skills & Tools" page.
 *
 * The authoritative registry lives in the main process: `BASE_SCHEMAS` (the JSON
 * schemas offered to the model) and `runTool` (the dispatch switch) in
 * `src/main/harness/agent.ts` + `src/main/harness/tools.ts`. This catalog is kept
 * in lockstep with them — every id here is a real, offered tool — and the shared
 * smoke tests guard against it drifting back out of sync.
 *
 * Originally mirrored opencode's tool set (github.com/sst/opencode, MIT); trimmed
 * and reconciled to the tools Roxy actually implements.
 */

export type ToolCategory = 'Files' | 'Shell' | 'Web' | 'Browser' | 'Automation' | 'Agents'

export interface ToolDef {
  id: string
  name: string
  description: string
  category: ToolCategory
  /** Whether the tool can modify the workspace or the outside world. */
  mutates: boolean
  /**
   * Whether cancelling this ONE call, mid-flight, does something real.
   *
   * This gates the per-call cancel button, and the rule is honesty: a button
   * that does nothing is worse than no button. It is true only for the tools
   * whose dispatch actually honors `ctx.signal` — either by killing the work
   * (`bash` kills the process tree, `webfetch`/`websearch` abort the request,
   * `grep`/`glob` break out of their scan) or by making the TURN stop waiting on
   * work that cannot itself be interrupted (the `untilAborted` calls: Electron
   * `webContents`, the language server, an MCP round trip).
   *
   * Everything else finishes in single-digit milliseconds — a local `read`, a
   * `list`, a loop toggle. There is no window in which you could click, so the
   * flag is false and no button is drawn.
   *
   * `task` is deliberately false despite being the longest-running tool of all:
   * it has a BETTER cancel of its own, addressed by the delegate's session id,
   * which tears the subagent down through its normal exit path and reports back
   * to the parent model properly (see `cancelSubagentRun`).
   */
  interruptible: boolean
}

export const TOOLS: ToolDef[] = [
  // ---- Files & search ----
  {
    id: 'read',
    name: 'read',
    description: 'Read a file from the workspace.',
    category: 'Files',
    mutates: false,
    interruptible: false
  },
  {
    id: 'write',
    name: 'write',
    description: 'Create or overwrite a file.',
    category: 'Files',
    mutates: true,
    interruptible: false
  },
  {
    id: 'edit',
    name: 'edit',
    description: 'Replace an exact, unique substring in a file.',
    category: 'Files',
    mutates: true,
    interruptible: false
  },
  {
    id: 'list',
    name: 'list',
    description: 'List the entries of a directory.',
    category: 'Files',
    mutates: false,
    interruptible: false
  },
  {
    id: 'glob',
    name: 'glob',
    description: 'Find files matching a glob pattern.',
    category: 'Files',
    mutates: false,
    // A glob over a huge tree (or a network drive) can run for a long time.
    interruptible: true
  },
  {
    id: 'grep',
    name: 'grep',
    description: 'Search file contents with a regex.',
    category: 'Files',
    mutates: false,
    // Scans up to 2000 files; the loop checks the signal between them.
    interruptible: true
  },

  // ---- Shell ----
  {
    id: 'bash',
    name: 'bash',
    description: 'Run a shell command (foreground or long-lived background).',
    category: 'Shell',
    mutates: true,
    // The headline case: `sleep 300`, a hung install, a test suite that wedged.
    // Cancelling kills the process tree for real (see killProc).
    interruptible: true
  },
  {
    id: 'bash_list',
    name: 'bash_list',
    description: 'List the running background processes.',
    category: 'Shell',
    mutates: false,
    interruptible: false
  },
  {
    id: 'bash_output',
    name: 'bash_output',
    description: 'Read new output from a background process.',
    category: 'Shell',
    mutates: false,
    interruptible: false
  },
  {
    id: 'bash_kill',
    name: 'bash_kill',
    description: 'Stop a background process.',
    category: 'Shell',
    mutates: true,
    interruptible: false
  },

  // ---- Web ----
  {
    id: 'webfetch',
    name: 'webfetch',
    description: 'Fetch a URL and return it as markdown, text, or HTML.',
    category: 'Web',
    mutates: false,
    // A dead host holds the socket open until the timeout; the fetch takes our signal.
    interruptible: true
  },
  {
    id: 'websearch',
    name: 'websearch',
    description: 'Search the web for fresh context beyond the training cutoff.',
    category: 'Web',
    mutates: false,
    interruptible: true
  },

  // ---- Browser (Roxy's persistent, logged-in browser) ----
  {
    id: 'browser_open',
    name: 'browser_open',
    description: 'Open or navigate the built-in browser to a URL (logins persist).',
    category: 'Browser',
    mutates: false,
    // `loadURL` against a slow host is the classic multi-minute hang. The
    // navigation itself cannot be aborted, but the turn stops waiting on it.
    interruptible: true
  },
  {
    id: 'browser_screenshot',
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the current page.',
    category: 'Browser',
    mutates: false,
    interruptible: true
  },
  {
    id: 'browser_read',
    name: 'browser_read',
    description: "Read the current page's HTML (optionally a CSS selector).",
    category: 'Browser',
    mutates: false,
    interruptible: true
  },
  {
    id: 'browser_console',
    name: 'browser_console',
    description: 'Read console logs and errors from the current page.',
    category: 'Browser',
    mutates: false,
    interruptible: false
  },
  {
    id: 'browser_click',
    name: 'browser_click',
    description: 'Click the first element matching a CSS selector.',
    category: 'Browser',
    mutates: true,
    interruptible: true
  },
  {
    id: 'browser_scroll',
    name: 'browser_scroll',
    description: 'Scroll the page into a selector or by direction.',
    category: 'Browser',
    mutates: true,
    interruptible: true
  },
  {
    id: 'browser_type',
    name: 'browser_type',
    description: 'Type text into a field matching a CSS selector.',
    category: 'Browser',
    mutates: true,
    interruptible: true
  },
  {
    id: 'browser_tabs',
    name: 'browser_tabs',
    description: 'List the open browser tabs and which is active.',
    category: 'Browser',
    mutates: false,
    interruptible: false
  },
  {
    id: 'browser_new_tab',
    name: 'browser_new_tab',
    description: 'Open a new browser tab (optionally at a URL).',
    category: 'Browser',
    mutates: true,
    interruptible: false
  },
  {
    id: 'browser_activate_tab',
    name: 'browser_activate_tab',
    description: 'Switch to a browser tab by its id.',
    category: 'Browser',
    mutates: true,
    interruptible: false
  },
  {
    id: 'browser_close',
    name: 'browser_close',
    description: 'Close the built-in browser.',
    category: 'Browser',
    mutates: true,
    interruptible: false
  },

  // ---- Automation (recurring loops + this session's metadata) ----
  {
    id: 'loop_create',
    name: 'loop_create',
    description: 'Create a scheduled loop that re-runs a prompt every N minutes.',
    category: 'Automation',
    mutates: true,
    interruptible: false
  },
  {
    id: 'loop_remove',
    name: 'loop_remove',
    description: 'Delete a loop by name or id.',
    category: 'Automation',
    mutates: true,
    interruptible: false
  },
  {
    id: 'loop_list',
    name: 'loop_list',
    description: 'List scheduled loops and whether each is running.',
    category: 'Automation',
    mutates: false,
    interruptible: false
  },
  {
    id: 'loop_enable',
    name: 'loop_enable',
    description: 'Resume a paused loop by name or id.',
    category: 'Automation',
    mutates: true,
    interruptible: false
  },
  {
    id: 'loop_disable',
    name: 'loop_disable',
    description: 'Pause a running loop by name or id.',
    category: 'Automation',
    mutates: true,
    interruptible: false
  },
  {
    id: 'change_session_metadata',
    name: 'change_session_metadata',
    description:
      "Set the session's title, description, task checklist, and workstream branch name.",
    category: 'Automation',
    mutates: true,
    interruptible: false
  },

  // ---- Agents & code intelligence ----
  {
    id: 'task',
    name: 'task',
    description: 'Spawn a subagent to handle a sub-task (optionally in the background).',
    category: 'Agents',
    mutates: false,
    // NOT interruptible by the generic per-call path — it has its own, better
    // cancel keyed by the delegate's session id. See the field's doc comment.
    interruptible: false
  },
  {
    id: 'skill',
    name: 'skill',
    description: 'Load a packaged SKILL.md skill on demand.',
    category: 'Agents',
    mutates: false,
    interruptible: false
  },
  {
    id: 'lsp',
    name: 'lsp',
    description: 'Report language-server diagnostics for a file.',
    category: 'Agents',
    mutates: false,
    // Waits on a language server that may still be indexing a large project.
    interruptible: true
  }
]

const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]))

export function getTool(id: string): ToolDef | undefined {
  return TOOL_BY_ID.get(id)
}

/** Resolve an agent's tool list ('all' expands to every tool id). */
export function resolveToolIds(tools: string[] | 'all'): string[] {
  return tools === 'all' ? TOOLS.map((t) => t.id) : tools
}

/** The distinct categories, in catalog order — for grouped rendering. */
export const TOOL_CATEGORIES: ToolCategory[] = [...new Set(TOOLS.map((t) => t.category))]

/**
 * Whether a running call to this tool can be cancelled on its own.
 *
 * Unknown names are treated as interruptible, which covers MCP tools: they are
 * contributed at runtime (so they can't be in this static catalog), they are a
 * network round trip to someone else's server, and `runTool` already routes them
 * through `untilAborted`. An unknown BUILT-IN name can't reach here — dispatch
 * would have rejected it — so the permissive default has no other reachable case.
 *
 * `skill_manage` is likewise absent from the catalog (it isn't offered on the
 * Skills & Tools page) but does take the signal for its GitHub fetch, so the
 * default is right for it too.
 */
export function isInterruptibleTool(name: string): boolean {
  const def = TOOL_BY_ID.get(name)
  return def ? def.interruptible : true
}
