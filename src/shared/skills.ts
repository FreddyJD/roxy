import type { SkillDef } from './types'

/**
 * Tools/skills the agent can use. All "coming soon" — the pages and wiring
 * exist so capabilities can be switched on as they land.
 */
export const SKILLS: SkillDef[] = [
  {
    id: 'browser',
    name: 'Browser',
    description: 'Let Roxy browse and operate the web.',
    status: 'coming-soon',
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
    status: 'coming-soon',
    icon: 'folder',
    category: 'System'
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'Run shell commands in a sandbox.',
    status: 'coming-soon',
    icon: 'terminal',
    category: 'System'
  },
  {
    id: 'web-search',
    name: 'Web Search',
    description: 'Search the web for fresh context.',
    status: 'coming-soon',
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
