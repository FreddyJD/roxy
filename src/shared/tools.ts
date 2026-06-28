/**
 * Tool catalog mirroring opencode's built-in tools (github.com/sst/opencode, MIT).
 * The model-facing description for each tool lives in
 * resources/prompts/tools/<id>.txt.
 */

export interface ToolDef {
  id: string
  name: string
  description: string
  /** Whether the tool can modify the workspace. */
  mutates: boolean
}

export const TOOLS: ToolDef[] = [
  { id: 'read', name: 'read', description: 'Read a file from the workspace.', mutates: false },
  { id: 'write', name: 'write', description: 'Create or overwrite a file.', mutates: true },
  { id: 'edit', name: 'edit', description: 'Make targeted edits to a file.', mutates: true },
  {
    id: 'apply_patch',
    name: 'apply_patch',
    description: 'Apply a unified patch across files.',
    mutates: true
  },
  { id: 'grep', name: 'grep', description: 'Search file contents with a regex.', mutates: false },
  { id: 'glob', name: 'glob', description: 'Find files by glob pattern.', mutates: false },
  { id: 'list', name: 'list', description: 'List directory contents.', mutates: false },
  { id: 'bash', name: 'bash', description: 'Run a shell command in the workspace.', mutates: true },
  { id: 'bash_list', name: 'bash_list', description: 'List background processes in the workspace.', mutates: false },
  { id: 'bash_output', name: 'bash_output', description: 'Read output from a background process.', mutates: false },
  { id: 'bash_kill', name: 'bash_kill', description: 'Stop a background process.', mutates: true },
  { id: 'webfetch', name: 'webfetch', description: 'Fetch the contents of a URL.', mutates: false },
  {
    id: 'websearch',
    name: 'websearch',
    description: 'Search the web for fresh context.',
    mutates: false
  },
  {
    id: 'browser_open',
    name: 'browser_open',
    description: 'Open or navigate the built-in browser to a URL (logins persist).',
    mutates: false
  },
  {
    id: 'browser_screenshot',
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the current browser page.',
    mutates: false
  },
  {
    id: 'browser_read',
    name: 'browser_read',
    description: "Read the current page's HTML (optionally a CSS selector).",
    mutates: false
  },
  {
    id: 'browser_console',
    name: 'browser_console',
    description: 'Read console logs and errors from the current page.',
    mutates: false
  },
  {
    id: 'browser_tabs',
    name: 'browser_tabs',
    description: 'List the open browser tabs and which is active.',
    mutates: false
  },
  {
    id: 'browser_new_tab',
    name: 'browser_new_tab',
    description: 'Open a new browser tab (optionally at a URL).',
    mutates: false
  },
  {
    id: 'browser_activate_tab',
    name: 'browser_activate_tab',
    description: 'Switch to a browser tab by its id.',
    mutates: false
  },
  {
    id: 'todowrite',
    name: 'todowrite',
    description: 'Track a structured todo list.',
    mutates: false
  },
  { id: 'task', name: 'task', description: 'Spawn a subagent to handle a sub-task.', mutates: false },
  {
    id: 'list_sessions',
    name: 'list_sessions',
    description: 'List all coding sessions and their status (used by loops).',
    mutates: false
  },
  {
    id: 'check_session',
    name: 'check_session',
    description: 'Check a session: last activity, message count, idle/active.',
    mutates: false
  },
  {
    id: 'loop_list',
    name: 'loop_list',
    description: 'List scheduled loops and whether each is running.',
    mutates: false
  },
  {
    id: 'loop_enable',
    name: 'loop_enable',
    description: 'Turn a loop on, by name or id.',
    mutates: true
  },
  {
    id: 'loop_disable',
    name: 'loop_disable',
    description: 'Turn a loop off, by name or id.',
    mutates: true
  },
  {
    id: 'change_session_metadata',
    name: 'change_session_metadata',
    description: "Set the session's name, description, and task checklist.",
    mutates: true
  },
  {
    id: 'lsp',
    name: 'lsp',
    description: 'Query the language server (diagnostics, hover).',
    mutates: false
  },
  {
    id: 'question',
    name: 'question',
    description: 'Ask the user a clarifying question.',
    mutates: false
  },
  { id: 'skill', name: 'skill', description: 'Invoke a packaged skill.', mutates: false }
]

const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]))

export function getTool(id: string): ToolDef | undefined {
  return TOOL_BY_ID.get(id)
}

/** Resolve an agent's tool list ('all' expands to every tool id). */
export function resolveToolIds(tools: string[] | 'all'): string[] {
  return tools === 'all' ? TOOLS.map((t) => t.id) : tools
}
