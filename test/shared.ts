/**
 * Pure-Node validation of the shared catalogs (no Electron, no DB).
 * Run: npm run smoke:shared
 */
import { TOOLS, getTool, resolveToolIds } from '../src/shared/tools'
import { AGENTS, getAgent, PRIMARY_AGENTS, SUBAGENTS, DEFAULT_AGENT_ID } from '../src/shared/agents'
import { SEED_PROVIDERS, resolveSeed, isConnectableNow } from '../src/shared/providers'

let pass = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  \u2713 ${name}`)
  } else {
    fails.push(name)
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

console.log('shared catalogs\n')

// ---- tools ----
check('tools non-empty', TOOLS.length > 0)
check('tool ids unique', new Set(TOOLS.map((t) => t.id)).size === TOOLS.length)
check(
  'browser tools registered',
  ['browser_open', 'browser_screenshot', 'browser_read', 'browser_console', 'browser_tabs'].every((id) =>
    Boolean(getTool(id))
  )
)
check(
  'loop tools registered',
  ['loop_list', 'loop_enable', 'loop_disable'].every((id) => Boolean(getTool(id)))
)
check('file/bash tools registered', ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'list'].every((id) => Boolean(getTool(id))))
check('resolveToolIds("all") expands to every tool', resolveToolIds('all').length === TOOLS.length)
check('resolveToolIds passthrough', resolveToolIds(['read', 'bash']).join() === 'read,bash')

// ---- agents ----
check('agents non-empty', AGENTS.length > 0)
check('default agent resolves', Boolean(getAgent(DEFAULT_AGENT_ID)))
check(
  'primary agents are visible primaries',
  PRIMARY_AGENTS.length > 0 && PRIMARY_AGENTS.every((a) => !a.hidden && a.mode === 'primary')
)
check(
  'subagents are visible subagents',
  SUBAGENTS.length > 0 && SUBAGENTS.every((a) => !a.hidden && a.mode === 'subagent')
)
check('getAgent(unknown) is undefined', getAgent('__nope__') === undefined)

// ---- providers ----
check('seed providers present', SEED_PROVIDERS.length > 10)
check('seed ids unique', new Set(SEED_PROVIDERS.map((p) => p.id)).size === SEED_PROVIDERS.length)
check('resolveSeed(known) matches', resolveSeed(SEED_PROVIDERS[0].id).id === SEED_PROVIDERS[0].id)
check('resolveSeed(unknown) returns a usable default', typeof resolveSeed('__x__').wire === 'string')
check('isConnectableNow returns boolean', typeof isConnectableNow(SEED_PROVIDERS[0]) === 'boolean')

if (fails.length) {
  console.error(`\nSHARED FAILED \u2014 ${fails.length} failing: ${fails.join(', ')}`)
  process.exit(1)
}
console.log(`\nSHARED OK \u2014 ${pass} checks passed`)
