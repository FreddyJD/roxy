/**
 * Agent + subagent catalog, mirroring opencode's built-in agents
 * (github.com/sst/opencode, MIT). A subagent is just a child session run through
 * the same loop with its own system prompt and a narrowed set of tools.
 *
 * Each agent's prompt lives in resources/prompts/<promptFile>; the model-default
 * prompt is used when promptFile is omitted.
 */

export type AgentMode = 'primary' | 'subagent'

export interface AgentDef {
  id: string
  name: string
  description: string
  mode: AgentMode
  /** Utility agents (e.g. compaction) — not shown to the user. */
  hidden: boolean
  color: string
  /** Tool ids this agent may use, or 'all'. */
  tools: string[] | 'all'
  /** Agent-specific prompt file in resources/prompts, when it overrides the default. */
  promptFile?: string
}

export const AGENTS: AgentDef[] = [
  {
    id: 'build',
    name: 'Build',
    description: 'The default coding agent — reads, edits, and runs commands to build features.',
    mode: 'primary',
    hidden: false,
    color: '#4d8dff',
    tools: 'all'
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only planning. Explores and proposes a plan without touching files.',
    mode: 'primary',
    hidden: false,
    color: '#3fb950',
    tools: ['read', 'grep', 'glob', 'list', 'bash', 'webfetch', 'websearch', 'skill'],
    promptFile: 'plan.txt'
  },
  {
    id: 'general',
    name: 'General',
    description:
      'General-purpose agent for researching complex questions and running multi-step tasks in parallel.',
    mode: 'subagent',
    hidden: false,
    color: '#a371f7',
    tools: 'all'
  },
  {
    id: 'explore',
    name: 'Explore',
    description: 'Fast, read-only agent specialized for searching and understanding codebases.',
    mode: 'subagent',
    hidden: false,
    color: '#f0883e',
    tools: ['grep', 'glob', 'list', 'bash', 'webfetch', 'websearch', 'read', 'skill'],
    promptFile: 'agent-explore.txt'
  },
  {
    id: 'compaction',
    name: 'Compaction',
    description: 'Summarizes conversation history to reclaim context.',
    mode: 'primary',
    hidden: true,
    color: '#8b8b93',
    tools: [],
    promptFile: 'agent-compaction.txt'
  }
]

const AGENT_BY_ID = new Map(AGENTS.map((a) => [a.id, a]))

export function getAgent(id: string): AgentDef | undefined {
  return AGENT_BY_ID.get(id)
}

export const PRIMARY_AGENTS = AGENTS.filter((a) => a.mode === 'primary' && !a.hidden)
export const SUBAGENTS = AGENTS.filter((a) => a.mode === 'subagent' && !a.hidden)
export const DEFAULT_AGENT_ID = 'build'
