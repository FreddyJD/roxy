/**
 * Pure-Node validation of the shared catalogs (no Electron, no DB).
 * Run: npm run smoke:shared
 */
import { TOOLS, getTool, resolveToolIds, TOOL_CATEGORIES } from '../src/shared/tools'
import {
  AGENTS,
  getAgent,
  isReadOnlyAgent,
  isWriteCapableSubagent,
  PRIMARY_AGENTS,
  SUBAGENTS,
  DEFAULT_AGENT_ID
} from '../src/shared/agents'
import { SEED_PROVIDERS, resolveSeed, isConnectableNow } from '../src/shared/providers'
import { pickDefaultModel } from '../src/shared/models'
import { randomSlug, uniqueSlug } from '../src/shared/slugs'
import { formatInterval } from '../src/shared/format'
import {
  selectPromptName,
  buildEnvironment,
  assembleSystemPrompt,
  ROXY_COAUTHOR_TRAILER,
  GIT_COMMIT_TRAILER_PROMPT
} from '../src/shared/prompt'
import {
  reconstructAssistant,
  reconstructTurn,
  flattenToolHistory,
  sanitizeToolCallId,
  REPLAY_OUTPUT_CAP
} from '../src/shared/tool-history'
import {
  PartsFold,
  partsToContent,
  streamSignature,
  countStreamedChars,
  CHILD_OUTPUT_CAP,
  MAX_CHILD_PARTS
} from '../src/shared/parts'
import {
  normalizeFetchUrl,
  acceptHeader,
  mimeFromContentType,
  isImageMime,
  isTextualMime,
  decodeEntities,
  htmlToText,
  htmlToMarkdown,
  convertWebContent,
  buildExaRequestBody,
  clampResults,
  parseExaResponse,
  WEBSEARCH_MAX_RESULTS,
  WEBSEARCH_DEFAULT_RESULTS
} from '../src/shared/web'
import { resolveWorktreeCwd } from '../src/shared/workspace'
import {
  contextBudgetFor,
  effectiveContextMax,
  parseReasoningEffort,
  resolveSessionConfig,
  seedSessionConfig
} from '../src/shared/session-config'
import {
  workstreamStripView,
  statusKeyForSession,
  type StripSession
} from '../src/shared/workstream'
import { posix as posixPath, win32 as win32Path } from 'node:path'
import type { Message, MessagePart } from '../src/shared/types'
import type { ChatMessage } from '../src/shared/api'
import {
  emptyUsage,
  addUsage,
  totalTokens,
  usageCost,
  isPriced,
  localDay,
  aggregateUsage
} from '../src/shared/cost'
import type { TokenUsage, UsageRecord } from '../src/shared/types'
import { aggregateActivity, activityLevel } from '../src/shared/activity'
import {
  estimateTokens,
  countLines,
  compactionThreshold,
  isOverflow,
  needsTruncation,
  previewText,
  pruneToolMessages,
  messageTokens,
  countContentImages,
  messagesToCompact,
  IMAGE_TOKEN_COST,
  COMPACTION_BUFFER,
  KEEP_RECENT_TOKENS,
  TOOL_OUTPUT_MAX_CHARS
} from '../src/shared/context'
import {
  MAX_PARALLEL_SUBAGENTS,
  mapWithConcurrency,
  parseTaskInput,
  partitionTasksByWriteCapability,
  runTasksByWriteCapability,
  partitionToolCalls,
  renderBackgroundStarted,
  renderTaskResult
} from '../src/shared/parallel'
import {
  RpcDecoder,
  encodeRpcMessage,
  extname as lspExtname,
  fileUriToPath,
  languageIdForPath,
  parseContentLength,
  pathToFileUri,
  prettyDiagnostic,
  renderDiagnosticsBlock,
  serverForPath,
  severityLabel,
  type LspDiagnostic
} from '../src/shared/lsp'
import {
  MCP_TOOL_PREFIX,
  MAX_TOOL_NAME,
  describeMcpForPrompt,
  isMcpToolName,
  mcpToolToSchema,
  normalizeServerConfig,
  normalizeServerRecords,
  qualifyToolName,
  renderMcpContent,
  sanitizeNamePart,
  type McpServerSummary
} from '../src/shared/mcp'
import {
  SKILL_TOOL_NAME,
  SKILL_TOOL_DESCRIPTION,
  SKILL_FILE_SAMPLE_LIMIT,
  parseSkillFrontmatter,
  serializeSkillMarkdown,
  isValidSkillName,
  resolveSkillSource,
  sanitizeSkillName,
  describeSkillsForPrompt,
  renderSkillContent,
  type SkillInfo
} from '../src/shared/skills'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNELS } from '../src/shared/ipc'
import {
  buildBundle,
  serializeBundle,
  parseBundle,
  summarizeBundle,
  isSafeSkillFilePath,
  BUNDLE_KIND,
  BUNDLE_VERSION
} from '../src/shared/portable'
import {
  parseRemote,
  splitRemoteUrl,
  forgeKindForHost,
  detectHost,
  branchLifecycle,
  relativeAge,
  FORGE_NAMES,
  type PullRequestView
} from '../src/shared/forge'
import {
  place,
  GAP,
  MARGIN,
  MAX_W,
  MAX_H,
  CHROME_H,
  type Rect
} from '../src/renderer/src/lib/anchor'

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
  ['browser_open', 'browser_screenshot', 'browser_read', 'browser_console', 'browser_tabs'].every(
    (id) => Boolean(getTool(id))
  )
)
check(
  'loop tools registered',
  ['loop_list', 'loop_enable', 'loop_disable'].every((id) => Boolean(getTool(id)))
)
check(
  'file/bash tools registered',
  ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'list'].every((id) => Boolean(getTool(id)))
)
check(
  'bash background tools registered',
  ['bash_list', 'bash_output', 'bash_kill'].every((id) => Boolean(getTool(id)))
)
check('resolveToolIds("all") expands to every tool', resolveToolIds('all').length === TOOLS.length)
check('resolveToolIds passthrough', resolveToolIds(['read', 'bash']).join() === 'read,bash')
// ---- catalog reflects reality (guards against drift back to the old aspirational list) ----
check(
  'every tool has a category',
  TOOLS.every((t) => TOOL_CATEGORIES.includes(t.category))
)
check(
  'reconciled real tools are present',
  [
    'task',
    'skill',
    'lsp',
    'browser_close',
    'loop_create',
    'loop_remove',
    'change_session_metadata'
  ].every((id) => Boolean(getTool(id)))
)
check(
  'removed aspirational tools are gone',
  ['apply_patch', 'todowrite', 'question', 'list_sessions', 'check_session'].every(
    (id) => !getTool(id)
  )
)

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
check(
  'resolveSeed(unknown) returns a usable default',
  typeof resolveSeed('__x__').wire === 'string'
)
check('isConnectableNow returns boolean', typeof isConnectableNow(SEED_PROVIDERS[0]) === 'boolean')

// ---- default model auto-pick ----
const mkModel = (id: string, toolCall = false): import('../src/shared/api').ModelInfo => ({
  id,
  name: id,
  reasoning: false,
  toolCall
})
check('pickDefaultModel: empty catalog → undefined', pickDefaultModel([]) === undefined)
check(
  'pickDefaultModel: prefers the first tool-capable model over an earlier non-tool one',
  pickDefaultModel([mkModel('a-new', false), mkModel('b-tools', true)]) === 'b-tools'
)
check(
  'pickDefaultModel: no tool-capable model → newest (first) overall',
  pickDefaultModel([mkModel('newest'), mkModel('older')]) === 'newest'
)
check(
  'pickDefaultModel: first entry wins when it is already tool-capable',
  pickDefaultModel([mkModel('latest', true), mkModel('older', true)]) === 'latest'
)

// ---- structured tool history (Phase 5) ----
const asMsg = (role: 'user' | 'assistant', parts: MessagePart[]): Message => ({
  id: 'm',
  chatId: 'c',
  role,
  content: '',
  parts,
  createdAt: 1
})

// A plain user turn → one user message.
check(
  'reconstructTurn: user turn → single user message',
  (() => {
    const r = reconstructTurn(asMsg('user', [{ type: 'text', text: 'hello' }]))
    return r.length === 1 && r[0].role === 'user' && r[0].content === 'hello'
  })()
)

// A plain assistant turn (reasoning skipped) → one assistant message, no tool calls.
check(
  'reconstructAssistant: text-only turn → one assistant, reasoning dropped',
  (() => {
    const r = reconstructAssistant([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'the answer' }
    ])
    return (
      r.length === 1 &&
      r[0].role === 'assistant' &&
      r[0].content === 'the answer' &&
      !r[0].toolCalls
    )
  })()
)

// text → tool → tool → text becomes: assistant(text+2 calls), 2 tool results, assistant(text).
check(
  'reconstructAssistant: multi-step tool turn keeps structure',
  (() => {
    const r = reconstructAssistant([
      { type: 'text', text: 'let me look' },
      {
        type: 'tool',
        tool: 'read',
        state: 'done',
        callId: 'a',
        input: { path: 'x.ts' },
        output: 'AAA'
      },
      {
        type: 'tool',
        tool: 'grep',
        state: 'done',
        callId: 'b',
        input: { pattern: 'foo' },
        output: 'BBB'
      },
      { type: 'text', text: 'done' }
    ])
    const [a0, t0, t1, a1] = r
    return (
      r.length === 4 &&
      a0.role === 'assistant' &&
      a0.content === 'let me look' &&
      a0.toolCalls?.length === 2 &&
      a0.toolCalls[0].id === 'a' &&
      a0.toolCalls[0].name === 'read' &&
      a0.toolCalls[0].arguments === JSON.stringify({ path: 'x.ts' }) &&
      t0.role === 'tool' &&
      t0.toolCallId === 'a' &&
      t0.content === 'AAA' &&
      t1.role === 'tool' &&
      t1.toolCallId === 'b' &&
      a1.role === 'assistant' &&
      a1.content === 'done' &&
      !a1.toolCalls
    )
  })()
)

// Every assistant tool-call id has a matching tool-result id (no orphans).
check(
  'reconstructAssistant: call ids pair with result ids',
  (() => {
    const r = reconstructAssistant([
      { type: 'tool', tool: 'read', state: 'done', callId: 'a', input: {}, output: 'x' },
      { type: 'tool', tool: 'bash', state: 'done', callId: 'b', input: {}, output: 'y' }
    ])
    const callIds = r
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.toolCalls?.map((c) => c.id) ?? [])
    const resultIds = r.filter((m) => m.role === 'tool').map((m) => m.toolCallId)
    return callIds.sort().join() === resultIds.sort().join() && callIds.join() === 'a,b'
  })()
)

// Legacy tool part (no callId, e.g. a `!verb` card) → old fenced-text flatten, no tool role.
check(
  'reconstructAssistant: legacy tool part (no callId) flattens to fenced text',
  (() => {
    const r = reconstructAssistant([
      { type: 'text', text: 'ran it' },
      { type: 'tool', tool: 'bash', state: 'done', title: 'ls', output: 'a\nb' }
    ])
    return (
      r.length === 1 &&
      r[0].role === 'assistant' &&
      !r[0].toolCalls &&
      r[0].content.includes('ran it') &&
      r[0].content.includes('```') &&
      r[0].content.includes('a\nb')
    )
  })()
)

// A missing/empty output persists as a placeholder, never an empty tool result.
check(
  'reconstructAssistant: empty tool output → "(no output)" placeholder',
  (() => {
    const r = reconstructAssistant([
      { type: 'tool', tool: 'read', state: 'done', callId: 'a', input: {} }
    ])
    const toolMsg = r.find((m) => m.role === 'tool')
    return toolMsg?.content === '(no output)'
  })()
)

// Oversized tool output is previewed (head + marker + tail) within the replay cap.
check(
  'reconstructAssistant: oversized tool output is previewed within the replay cap',
  (() => {
    const big = 'z'.repeat(REPLAY_OUTPUT_CAP + 500)
    const r = reconstructAssistant([
      { type: 'tool', tool: 'read', state: 'done', callId: 'a', input: {}, output: big }
    ])
    const toolMsg = r.find((m) => m.role === 'tool')
    const content = toolMsg?.content ?? ''
    return (
      content.length <= REPLAY_OUTPUT_CAP + 200 &&
      content.startsWith('z') &&
      content.includes('truncated')
    )
  })()
)

// flattenToolHistory folds tool results into the assistant bubble and drops the tool role.
check(
  'flattenToolHistory: folds tool results, emits no tool role',
  (() => {
    const structured: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'checking',
        toolCalls: [{ id: 'a', name: 'read', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 'a', content: 'FILE BODY' },
      { role: 'assistant', content: 'done' }
    ]
    const flat = flattenToolHistory(structured)
    const hasToolRole = flat.some((m) => m.role === 'tool')
    const merged = flat.find((m) => m.role === 'assistant')
    return (
      !hasToolRole &&
      flat[0].role === 'user' &&
      !!merged &&
      merged.content.includes('checking') &&
      merged.content.includes('FILE BODY')
    )
  })()
)

// flattenToolHistory leaves a plain (tool-free) conversation untouched.
check(
  'flattenToolHistory: plain conversation is unchanged',
  (() => {
    const plain: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    const flat = flattenToolHistory(plain)
    return flat.length === 2 && flat[0].content === 'hi' && flat[1].content === 'hello'
  })()
)

// ---- sanitizeToolCallId: the Copilot Claude tool_use.id pattern (letters/digits/hyphens) ----
// Guards the wire error: tool_use.id must match the letters/digits/hyphens-only pattern.
const TOOL_ID_OK = /^[a-zA-Z0-9-]+$/

// Underscores (OpenAI-style call_... / Anthropic toolu_...) are rejected by Copilot's proxy.
check(
  'sanitizeToolCallId: underscores become hyphens',
  sanitizeToolCallId('call_abc123') === 'call-abc123' &&
    sanitizeToolCallId('toolu_01ABC') === 'toolu-01ABC'
)

// MCP ids carry dots + colons (e.g. server.tool:1) so every invalid char is replaced.
check(
  'sanitizeToolCallId: dots and colons become hyphens',
  (() => {
    const out = sanitizeToolCallId('server.tool:1')
    return out === 'server-tool-1' && TOOL_ID_OK.test(out)
  })()
)

// A valid id is returned byte-for-byte (a no-op on providers that already accept it).
check(
  'sanitizeToolCallId: an already-valid id passes through unchanged',
  sanitizeToolCallId('abc-123-DEF') === 'abc-123-DEF'
)

// Empty / nullish ids get a stable placeholder so the pattern quantifier never fails on empty.
check(
  'sanitizeToolCallId: empty/undefined id gets a valid placeholder',
  (() => {
    const a = sanitizeToolCallId('')
    const b = sanitizeToolCallId(undefined)
    const c = sanitizeToolCallId(null)
    return a === 'tool-call' && b === 'tool-call' && c === 'tool-call' && TOOL_ID_OK.test(a)
  })()
)

// Deterministic: the SAME raw id always maps to the SAME sanitized id, so an
// assistant tool_calls[].id and its paired tool_call_id stay matched on replay.
check(
  'sanitizeToolCallId: deterministic (call id and result id stay paired)',
  sanitizeToolCallId('functions.exec:0') === sanitizeToolCallId('functions.exec:0')
)

// Whatever comes out always satisfies the strict pattern (fuzz over gnarly inputs).
check(
  'sanitizeToolCallId: output always matches the strict tool_use.id pattern',
  ['call_1', 'a.b:c', ' functions.exec:0', 'toolu_x|y', '???', '', 'OK-9'].every((raw) =>
    TOOL_ID_OK.test(sanitizeToolCallId(raw))
  )
)

// ---- web helpers (Phase 6: webfetch + websearch) ----
check(
  'normalizeFetchUrl upgrades http→https',
  normalizeFetchUrl('http://example.com/x') === 'https://example.com/x'
)
check(
  'normalizeFetchUrl keeps https',
  normalizeFetchUrl('https://example.com/') === 'https://example.com/'
)
check(
  'normalizeFetchUrl rejects file: scheme',
  (() => {
    try {
      normalizeFetchUrl('file:///etc/passwd')
      return false
    } catch {
      return true
    }
  })()
)
check(
  'normalizeFetchUrl rejects garbage',
  (() => {
    try {
      normalizeFetchUrl('not a url')
      return false
    } catch {
      return true
    }
  })()
)
check(
  'acceptHeader markdown prefers markdown',
  acceptHeader('markdown').startsWith('text/markdown')
)
check(
  'mimeFromContentType strips charset',
  mimeFromContentType('text/html; charset=utf-8') === 'text/html'
)
check('isImageMime true for png', isImageMime('image/png'))
check('isImageMime false for svg (treated as text)', !isImageMime('image/svg+xml'))
check(
  'isTextualMime true for json',
  isTextualMime('application/json') && isTextualMime('text/plain')
)
check('isTextualMime false for pdf', !isTextualMime('application/pdf'))
check(
  'decodeEntities named + numeric',
  decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;') === 'a & b <c> A B'
)
check(
  'htmlToText strips tags + script/style',
  (() => {
    const html =
      '<html><head><style>.x{color:red}</style></head><body><h1>Title</h1><script>evil()</script><p>Hello <b>world</b>.</p></body></html>'
    const t = htmlToText(html)
    return (
      t.includes('Title') &&
      t.includes('Hello world.') &&
      !t.includes('evil') &&
      !t.includes('color:red') &&
      !t.includes('<')
    )
  })()
)
check(
  'htmlToMarkdown converts headings, links, lists',
  (() => {
    const html =
      '<body><h2>Docs</h2><p>See <a href="https://x.dev/a">the guide</a>.</p><ul><li>one</li><li>two</li></ul></body>'
    const md = htmlToMarkdown(html)
    return (
      md.includes('## Docs') &&
      md.includes('[the guide](https://x.dev/a)') &&
      md.includes('- one') &&
      md.includes('- two')
    )
  })()
)
check(
  'htmlToMarkdown preserves code blocks',
  (() => {
    const md = htmlToMarkdown('<body><pre><code>const a = 1;\nconst b = 2;</code></pre></body>')
    return md.includes('```') && md.includes('const a = 1;') && md.includes('const b = 2;')
  })()
)
check(
  'convertWebContent passes through non-HTML untouched',
  convertWebContent('{"a":1}', 'application/json', 'markdown') === '{"a":1}'
)
check(
  'convertWebContent html format returns raw html',
  convertWebContent('<p>hi</p>', 'text/html', 'html') === '<p>hi</p>'
)
check(
  'clampResults default when invalid',
  clampResults('abc') === WEBSEARCH_DEFAULT_RESULTS && clampResults(0) === WEBSEARCH_DEFAULT_RESULTS
)
check('clampResults caps at max', clampResults(999) === WEBSEARCH_MAX_RESULTS)
check('clampResults passes valid through', clampResults(5) === 5)
check(
  'buildExaRequestBody is valid JSON-RPC tools/call',
  (() => {
    const body = JSON.parse(buildExaRequestBody('roxy harness', 8)) as {
      jsonrpc: string
      method: string
      params: { name: string; arguments: { query: string; numResults: number } }
    }
    return (
      body.jsonrpc === '2.0' &&
      body.method === 'tools/call' &&
      body.params.name === 'web_search_exa' &&
      body.params.arguments.query === 'roxy harness' &&
      body.params.arguments.numResults === 8
    )
  })()
)
check(
  'parseExaResponse reads a direct JSON body',
  parseExaResponse('{"result":{"content":[{"type":"text","text":"result A"}]}}') === 'result A'
)
check(
  'parseExaResponse reads an SSE data: stream',
  parseExaResponse(
    'event: message\ndata: {"result":{"content":[{"type":"text","text":"streamed B"}]}}\n\n'
  ) === 'streamed B'
)
check(
  'parseExaResponse returns undefined on empty/garbage',
  parseExaResponse('not json') === undefined
)

// ---- context management (Phase 9) ----
console.log('\ncontext management\n')

// token/line estimates
check('estimateTokens ~4 chars/token', estimateTokens('a'.repeat(400)) === 100)
check('countLines counts newlines + 1', countLines('a\nb\nc') === 3)
check('countLines of empty is 0', countLines('') === 0)

// overflow vs the model's real limit (minus reply/buffer headroom)
check(
  'compactionThreshold reserves the larger of output/buffer',
  compactionThreshold(200_000, 4_096) === 200_000 - COMPACTION_BUFFER &&
    compactionThreshold(200_000, 40_000) === 200_000 - 40_000
)
check('compactionThreshold is 0 for a missing limit', compactionThreshold(0, 4_096) === 0)
check(
  'compactionThreshold stays positive for a small window (regression guard)',
  (() => {
    const t = compactionThreshold(16_384, 4_096) // reserve would be 20k > window
    return t > 0 && t === 16_384 - Math.floor(16_384 * 0.3)
  })()
)
check(
  'isOverflow still fires on a small-context model',
  isOverflow(13_000, 16_384, 4_096) === true && isOverflow(9_000, 16_384, 4_096) === false
)
check(
  'isOverflow trips only above the threshold',
  isOverflow(190_000, 200_000, 4_096) === true && isOverflow(150_000, 200_000, 4_096) === false
)
check('isOverflow is false when the limit is unknown', isOverflow(999_999, 0, 4_096) === false)
check(
  'isOverflow adapts to a large output reserve',
  isOverflow(170_000, 200_000, 40_000) === true && isOverflow(170_000, 200_000, 4_096) === false
)

// tool-output preview (head + marker + tail), char-based
check('needsTruncation false for small output', needsTruncation('small') === false)
check(
  'needsTruncation true past the char bound',
  needsTruncation('x'.repeat(TOOL_OUTPUT_MAX_CHARS + 1)) === true
)
check('needsTruncation true past the line bound', needsTruncation('y\n'.repeat(2_100)) === true)
check(
  'previewText returns short text unchanged',
  previewText('just a line', { maxLines: 40, maxChars: 400 }) === 'just a line'
)
const bigPreview = previewText('L'.repeat(5_000) + '\nTAILMARK', {
  maxLines: 40,
  maxChars: 400,
  marker: '[[cut]]'
})
check('previewText keeps the head', bigPreview.startsWith('L'))
check('previewText inserts the marker', bigPreview.includes('[[cut]]'))
check('previewText keeps the tail', bigPreview.includes('TAILMARK'))
check('previewText respects the char budget', bigPreview.length < 5_000)

// turn-aware pruning: recent tool outputs intact, older ones shrunk to a preview
const bigOut = 'D'.repeat(12_000)
const convo = [
  { role: 'user', content: 'start' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'a', type: 'function', function: { name: 'grep', arguments: '{}' } }]
  },
  { role: 'tool', tool_call_id: 'a', content: bigOut }, // OLD — should shrink
  ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'F'.repeat(8_000) })), // push the old tool past the recent window
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'b', type: 'function', function: { name: 'grep', arguments: '{}' } }]
  },
  { role: 'tool', tool_call_id: 'b', content: bigOut } // RECENT — stays intact
]
const prunedConvo = pruneToolMessages(convo, { keepRecentTokens: KEEP_RECENT_TOKENS })
check(
  'pruneToolMessages preserves length + order',
  prunedConvo.length === convo.length && prunedConvo[0] === convo[0]
)
check(
  'pruneToolMessages shrinks the OLD tool output',
  (prunedConvo[2].content as string).length < bigOut.length
)
check(
  'pruneToolMessages keeps the RECENT tool output intact',
  prunedConvo[prunedConvo.length - 1].content === bigOut
)
check(
  'pruneToolMessages never touches non-tool messages',
  prunedConvo.every((m, i) => m.role === 'tool' || m.content === convo[i].content)
)
check(
  'pruneToolMessages leaves a small conversation untouched',
  (() => {
    const small = [{ role: 'tool', tool_call_id: 'z', content: 'tiny' }]
    return pruneToolMessages(small)[0].content === 'tiny'
  })()
)

// ---- messageTokens / images: an image is charged flat, NOT by its base64 length ----
// The empty-messages 400 on Copilot+image came from sizing an image by
// JSON.stringify(content) (the whole base64 data URL), so one screenshot read as
// 100k+ tokens and the trimmer dropped the user turn. These lock in flat sizing.
const fakeDataUrl = 'data:image/png;base64,' + 'A'.repeat(200_000)
const imageContent = [
  { type: 'text', text: 'look at this' },
  { type: 'image_url', image_url: { url: fakeDataUrl } }
]

check(
  'countContentImages: counts image_url parts, ignores text/strings',
  countContentImages(imageContent) === 1 &&
    countContentImages('plain string') === 0 &&
    countContentImages([{ type: 'text', text: 'hi' }]) === 0
)

check(
  'messageTokens: a plain-text message is ~chars/4',
  messageTokens({ content: 'x'.repeat(400) }) === 100
)

check(
  'messageTokens: an image is charged the flat cost, not its base64 length',
  (() => {
    const tokens = messageTokens({ content: imageContent })
    // 'look at this' = 12 chars -> 3 tokens, + one image flat. If the base64 were
    // counted it would be ~50k tokens, so assert it stays tiny.
    return tokens === Math.ceil(12 / 4) + IMAGE_TOKEN_COST && tokens < 1000
  })()
)

check(
  'messageTokens: a big pasted image never looks like an overflow',
  messageTokens({ content: imageContent }) < 5_000
)

check(
  'messageTokens: includes tool_calls args in the estimate',
  (() => {
    const withCalls = {
      content: null,
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }
      ]
    }
    return messageTokens(withCalls) > 0
  })()
)

// ---- messagesToCompact: never summarize away a trailing unanswered user turn ----
// This is the empty-messages 400 root cause: compaction fires right after the new
// user message is persisted, so it's the newest row. Summarizing it (and marking
// the summary through its timestamp) drops it from the live window -> system-only
// request -> 400. So a trailing user turn is held back from the summary.
check(
  'messagesToCompact: excludes a trailing (unanswered) user turn',
  (() => {
    const msgs = [
      { role: 'user', createdAt: 1 },
      { role: 'assistant', createdAt: 2 },
      { role: 'user', createdAt: 3 }
    ]
    const out = messagesToCompact(msgs)
    const last = out[out.length - 1]
    return out.length === 2 && last.role === 'assistant' && last.createdAt === 2
  })()
)

check(
  'messagesToCompact: keeps all when the last turn is an assistant reply',
  (() => {
    const msgs = [
      { role: 'user', createdAt: 1 },
      { role: 'assistant', createdAt: 2 }
    ]
    return messagesToCompact(msgs).length === 2
  })()
)

check(
  'messagesToCompact: a lone unanswered user turn yields nothing to summarize',
  messagesToCompact([{ role: 'user', createdAt: 1 }]).length === 0
)

check('messagesToCompact: empty in, empty out', messagesToCompact([]).length === 0)

// cross-turn replay now previews (head + tail) instead of a head-only slice
const replayTurn: Message = {
  id: 'm1',
  chatId: 'c1',
  role: 'assistant',
  content: '',
  parts: [
    {
      type: 'tool',
      tool: 'grep',
      callId: 'r1',
      input: {},
      output: 'HEAD'.repeat(3_000) + 'UNIQUETAIL',
      state: 'done'
    }
  ] as MessagePart[],
  createdAt: 1
} as Message
const replayed = reconstructTurn(replayTurn)
const replayedTool = replayed.find((m) => m.role === 'tool')
check('reconstruct replays a tool result', !!replayedTool)
check('reconstruct preview keeps the head', (replayedTool?.content ?? '').startsWith('HEAD'))
check('reconstruct preview keeps the tail', (replayedTool?.content ?? '').includes('UNIQUETAIL'))
check(
  'reconstruct preview stays within the replay cap window',
  (replayedTool?.content ?? '').length <= REPLAY_OUTPUT_CAP + 200
)

// ---- parallel + task planning (Phase 11) ----
check('MAX_PARALLEL_SUBAGENTS is a positive cap', MAX_PARALLEL_SUBAGENTS >= 1)

const partitioned = partitionToolCalls([
  { id: 'a', name: 'task' },
  { id: 'b', name: 'read' },
  { id: 'c', name: 'task' },
  { id: 'd', name: 'bash' }
])
check(
  'partitionToolCalls splits tasks from others',
  partitioned.tasks.length === 2 && partitioned.others.length === 2
)
check(
  'partitionToolCalls preserves task order',
  partitioned.tasks.map((c) => c.id).join() === 'a,c'
)
check(
  'partitionToolCalls preserves other order',
  partitioned.others.map((c) => c.id).join() === 'b,d'
)

const ti = parseTaskInput(
  JSON.stringify({ description: 'do it', prompt: 'the ask', subagent_type: 'explore' })
)
check(
  'parseTaskInput reads fields',
  ti.description === 'do it' && ti.prompt === 'the ask' && ti.subagentType === 'explore'
)
check('parseTaskInput defaults foreground', ti.background === false)
check(
  'parseTaskInput defaults subagent to general',
  parseTaskInput('{}').subagentType === 'general'
)
check('parseTaskInput default description', parseTaskInput('{}').description === 'subtask')
check(
  'parseTaskInput background=true (bool)',
  parseTaskInput(JSON.stringify({ background: true })).background === true
)
check(
  'parseTaskInput background="true" (string)',
  parseTaskInput(JSON.stringify({ background: 'true' })).background === true
)
check(
  'parseTaskInput background="1"',
  parseTaskInput(JSON.stringify({ background: '1' })).background === true
)
check(
  'parseTaskInput other background string is false',
  parseTaskInput(JSON.stringify({ background: 'nope' })).background === false
)
check(
  'parseTaskInput task_id passthrough',
  parseTaskInput(JSON.stringify({ task_id: 'sess_9' })).taskId === 'sess_9'
)
check('parseTaskInput task_id absent → undefined', parseTaskInput('{}').taskId === undefined)
check(
  'parseTaskInput tolerates malformed JSON',
  parseTaskInput('{not json').subagentType === 'general'
)

const okRes = renderTaskResult('explore', 'completed', 'found it')
check(
  'renderTaskResult completed uses task_result',
  okRes.includes('<task_result>') && okRes.includes('state="completed"')
)
check('renderTaskResult includes body', okRes.includes('found it'))
const errRes = renderTaskResult('general', 'error', 'boom')
check(
  'renderTaskResult error uses task_error',
  errRes.includes('<task_error>') && errRes.includes('state="error"')
)
check(
  'renderTaskResult includes summary when given',
  renderTaskResult('explore', 'completed', 'x', 'a summary').includes(
    '<summary>a summary</summary>'
  )
)
const started = renderBackgroundStarted('general', 'crunch data')
check('renderBackgroundStarted names the task', started.includes('crunch data'))
check('renderBackgroundStarted warns against polling', /DO NOT poll/i.test(started))

// ---- PartsFold: one fold for local / remote / main, incl. nested subagents ----
{
  const fold = new PartsFold()
  fold.apply({ type: 'reasoning', delta: 'hmm' })
  fold.apply({ type: 'reasoning', delta: '…' })
  fold.apply({ type: 'text', delta: 'Hello' })
  fold.apply({ type: 'text', delta: ' world' })
  check(
    'fold: consecutive deltas grow one part per kind',
    fold.parts.length === 2 &&
      fold.parts[0].type === 'reasoning' &&
      fold.parts[0].text === 'hmm…' &&
      fold.parts[1].type === 'text' &&
      fold.parts[1].text === 'Hello world'
  )

  const before = fold.parts
  fold.apply({ type: 'text', delta: '!' })
  check('fold: returns a NEW array so React re-renders', fold.parts !== before)

  fold.apply({
    type: 'tool-start',
    callId: 'c1',
    tool: 'bash',
    title: 'ls',
    input: { command: 'ls' }
  })
  fold.apply({ type: 'tool-delta', callId: 'c1', chunk: 'a.txt\n' })
  fold.apply({ type: 'tool-end', callId: 'c1', output: 'a.txt\nb.txt', ok: true })
  const tool = fold.parts[2]
  check(
    'fold: tool card runs then resolves with its id + input kept',
    tool.type === 'tool' &&
      tool.state === 'done' &&
      tool.callId === 'c1' &&
      tool.output === 'a.txt\nb.txt' &&
      (tool.input as { command?: string }).command === 'ls'
  )

  fold.apply({ type: 'tool-end', callId: 'nope', output: 'x', ok: true })
  check('fold: an unknown callId is ignored, not appended', fold.parts.length === 3)
}

{
  // The point of the feature: a subagent's steps nest INSIDE its task card and
  // never leak into the parent's top-level parts.
  const fold = new PartsFold()
  fold.apply({ type: 'tool-start', callId: 't1', tool: 'task', title: 'Explore: map it' })
  fold.apply({ type: 'tool-child', callId: 't1', event: { type: 'reasoning', delta: 'plan' } })
  fold.apply({
    type: 'tool-child',
    callId: 't1',
    event: { type: 'tool-start', callId: 'c1', tool: 'grep', title: 'foo' }
  })
  fold.apply({
    type: 'tool-child',
    callId: 't1',
    event: { type: 'tool-end', callId: 'c1', output: 'hit', ok: true }
  })
  fold.apply({ type: 'tool-child', callId: 't1', event: { type: 'text', delta: 'Found it.' } })

  check('fold/nested: parent keeps exactly one top-level card', fold.parts.length === 1)
  const task = fold.parts[0]
  check(
    'fold/nested: subagent steps land in children, in order',
    task.type === 'tool' &&
      task.children?.length === 3 &&
      task.children[0].type === 'reasoning' &&
      task.children[1].type === 'tool' &&
      task.children[1].tool === 'grep' &&
      task.children[1].state === 'done' &&
      task.children[2].type === 'text' &&
      task.children[2].text === 'Found it.'
  )
  check(
    'fold/nested: the task card itself is still running until its own tool-end',
    task.type === 'tool' && task.state === 'running'
  )

  fold.apply({ type: 'tool-end', callId: 't1', output: 'The report.', ok: true })
  const done = fold.parts[0]
  check(
    'fold/nested: the report resolves the card without losing the transcript',
    done.type === 'tool' &&
      done.state === 'done' &&
      done.output === 'The report.' &&
      done.children?.length === 3
  )

  // A child event for a task card that was never announced must be dropped, not
  // mis-attributed to some other card.
  const stray = fold.parts
  fold.apply({ type: 'tool-child', callId: 'ghost', event: { type: 'text', delta: 'x' } })
  check('fold/nested: a child with no parent card is dropped', fold.parts === stray)
}

{
  // Two concurrent subagents must not cross transcripts — they share child call
  // ids (each subagent numbers its own calls), so the fold keys by parent card.
  const fold = new PartsFold()
  fold.apply({ type: 'tool-start', callId: 'A', tool: 'task', title: 'one' })
  fold.apply({ type: 'tool-start', callId: 'B', tool: 'task', title: 'two' })
  fold.apply({
    type: 'tool-child',
    callId: 'A',
    event: { type: 'tool-start', callId: 'c1', tool: 'read', title: 'a.ts' }
  })
  fold.apply({
    type: 'tool-child',
    callId: 'B',
    event: { type: 'tool-start', callId: 'c1', tool: 'read', title: 'b.ts' }
  })
  fold.apply({
    type: 'tool-child',
    callId: 'B',
    event: { type: 'tool-end', callId: 'c1', output: 'B!', ok: true }
  })
  const [a, b] = fold.parts
  check(
    'fold/nested: colliding child ids stay in their own parent',
    a.type === 'tool' &&
      b.type === 'tool' &&
      a.children?.length === 1 &&
      b.children?.length === 1 &&
      a.children[0].type === 'tool' &&
      a.children[0].title === 'a.ts' &&
      a.children[0].state === 'running' &&
      b.children[0].type === 'tool' &&
      b.children[0].output === 'B!' &&
      b.children[0].state === 'done'
  )
}

{
  // Nested output is a summary view: the sub session holds the full thing, so the
  // parent row must not balloon with a subagent's megabyte of tool output.
  const fold = new PartsFold()
  fold.apply({ type: 'tool-start', callId: 't1', tool: 'task', title: 'big' })
  fold.apply({
    type: 'tool-child',
    callId: 't1',
    event: { type: 'tool-start', callId: 'c1', tool: 'bash', title: 'noise' }
  })
  fold.apply({
    type: 'tool-child',
    callId: 't1',
    event: { type: 'tool-end', callId: 'c1', output: 'x\n'.repeat(50_000), ok: true }
  })
  const task = fold.parts[0]
  const childOut =
    task.type === 'tool' && task.children?.[0].type === 'tool'
      ? (task.children[0].output ?? '')
      : ''
  check(
    'fold/nested: a huge child output is capped for the parent row',
    childOut.length > 0 && childOut.length <= CHILD_OUTPUT_CAP + 200,
    `len=${childOut.length}`
  )

  // And a runaway step count can't grow the row without bound either.
  for (let i = 0; i < MAX_CHILD_PARTS + 50; i++) {
    fold.apply({
      type: 'tool-child',
      callId: 't1',
      event: { type: 'tool-start', callId: `x${i}`, tool: 'read', title: `f${i}` }
    })
  }
  const capped = fold.parts[0]
  check(
    'fold/nested: nested parts stop appending at the cap',
    capped.type === 'tool' && (capped.children?.length ?? 0) === MAX_CHILD_PARTS
  )
}

{
  // The liveness signal must see nested activity, or the "thinking" indicator
  // flips on while a subagent is visibly streaming inside its card.
  const fold = new PartsFold()
  fold.apply({ type: 'tool-start', callId: 't1', tool: 'task', title: 'x' })
  const quietSig = streamSignature(fold.parts)
  fold.apply({ type: 'tool-child', callId: 't1', event: { type: 'text', delta: 'working' } })
  check(
    'fold: streamSignature changes on nested activity',
    streamSignature(fold.parts) !== quietSig
  )
  check(
    'fold: countStreamedChars counts nested text',
    countStreamedChars(fold.parts) === 'working'.length
  )

  check(
    'partsToContent prefers prose over tool output',
    partsToContent([
      { type: 'tool', tool: 'bash', state: 'done', output: 'raw' },
      { type: 'text', text: '  done  ' }
    ]) === 'done'
  )
}

{
  // ---- PartsFold.seed: resuming a run already in progress ----
  // Opening a subagent's session mid-run seeds the renderer's fold from main's
  // snapshot. Seeding must rebuild the call-id index, or every card inherited
  // from the snapshot would ignore its own tool-end and spin forever.
  const live = new PartsFold()
  live.apply({ type: 'text', delta: 'looking' })
  live.apply({ type: 'tool-start', callId: 'c1', tool: 'bash', title: 'ls' })
  live.apply({ type: 'tool-start', callId: 'c2', tool: 'read', title: 'a.ts' })
  const snapshot = live.parts

  const viewer = new PartsFold()
  viewer.seed(snapshot)
  check('fold/seed: adopts the snapshot as-is', viewer.parts.length === 3)

  // The events that arrive AFTER the viewer joined must land on the right cards.
  viewer.apply({ type: 'tool-end', callId: 'c1', output: 'a.ts b.ts', ok: true })
  viewer.apply({ type: 'tool-end', callId: 'c2', output: 'contents', ok: false })
  const c1 = viewer.parts[1]
  const c2 = viewer.parts[2]
  check(
    'fold/seed: a tool started before the viewer joined still resolves',
    c1.type === 'tool' && c1.state === 'done' && c1.output === 'a.ts b.ts'
  )
  check(
    'fold/seed: and an error result lands on the right card too',
    c2.type === 'tool' && c2.state === 'error' && c2.output === 'contents'
  )

  // Prose keeps growing from where the snapshot left off rather than fragmenting.
  viewer.apply({ type: 'text', delta: ' more' })
  const tail = viewer.parts[viewer.parts.length - 1]
  check(
    'fold/seed: text after a seed appends a fresh part, not a rewrite',
    tail.type === 'text' && tail.text === ' more'
  )

  // Seeding is immutable toward the snapshot: main keeps folding into its own
  // instance, and a viewer must never mutate the array it was handed.
  check('fold/seed: does not mutate the source parts', snapshot.length === 3)
}

{
  // A seeded fold must also resume NESTED transcripts — a subagent's task card
  // rebuilt from a snapshot has to keep folding its own children correctly.
  const live = new PartsFold()
  live.apply({ type: 'tool-start', callId: 't1', tool: 'task', title: 'delegate' })
  live.apply({
    type: 'tool-child',
    callId: 't1',
    event: { type: 'tool-start', callId: 'n1', tool: 'grep', title: 'find' }
  })
  const viewer = new PartsFold()
  viewer.seed(live.parts)
  viewer.apply({
    type: 'tool-child',
    callId: 't1',
    event: { type: 'tool-end', callId: 'n1', output: 'found', ok: true }
  })
  const card = viewer.parts[0]
  const nested = card.type === 'tool' ? card.children?.[0] : undefined
  check(
    'fold/seed: nested children resume on the right slots',
    nested?.type === 'tool' && nested.state === 'done' && nested.output === 'found'
  )
}

{
  // A subagent's steps are display-only: replaying them as the parent's own
  // tool_calls would feed the model calls it never made.
  const replayed = reconstructAssistant([
    {
      type: 'tool',
      tool: 'task',
      state: 'done',
      callId: 't1',
      input: { description: 'go' },
      output: 'The report.',
      children: [
        { type: 'text', text: 'internal chatter' },
        { type: 'tool', tool: 'grep', state: 'done', callId: 'c1', output: 'hit' }
      ]
    }
  ])
  const calls = replayed.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
  check(
    'reconstructAssistant replays the task call ONLY, never its children',
    calls.length === 1 && calls[0].id === 't1' && calls[0].name === 'task'
  )
  check(
    'reconstructAssistant gives the model the report as the task result',
    replayed.some((m) => m.role === 'tool' && m.toolCallId === 't1' && m.content === 'The report.')
  )
  check(
    'reconstructAssistant never leaks nested output into the transcript',
    !replayed.some((m) => m.content.includes('internal chatter') || m.content.includes('hit'))
  )
}

// ---- LSP: framing + registry + uri + rendering (Phase 12) ----

// JSON-RPC Content-Length framing round-trips through the incremental decoder.
const rpcDecoder = new RpcDecoder()
const framed = encodeRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' })
const framedText = new TextDecoder().decode(framed)
check(
  'encodeRpcMessage writes a Content-Length header',
  /^Content-Length: \d+\r\n\r\n/.test(framedText)
)
const decodedOne = rpcDecoder.push(framed)
check(
  'RpcDecoder decodes a whole message',
  decodedOne.length === 1 && (decodedOne[0] as { method?: string }).method === 'initialize'
)

// Two messages concatenated in one chunk both come out.
const d2 = new RpcDecoder()
const two = encodeRpcMessage({ id: 1 })
const three = encodeRpcMessage({ id: 2 })
const both = new Uint8Array(two.length + three.length)
both.set(two, 0)
both.set(three, two.length)
const decodedTwo = d2.push(both)
check('RpcDecoder decodes two messages in one chunk', decodedTwo.length === 2)

// A message split across chunk boundaries is buffered until complete.
const d3 = new RpcDecoder()
const whole = encodeRpcMessage({ id: 7, method: 'x' })
const cut = Math.floor(whole.length / 2)
check('RpcDecoder buffers a partial message', d3.push(whole.subarray(0, cut)).length === 0)
const rest = d3.push(whole.subarray(cut))
check(
  'RpcDecoder completes a split message',
  rest.length === 1 && (rest[0] as { id?: number }).id === 7
)

// Byte-accurate for multi-byte UTF-8 (Content-Length is bytes, not chars).
const d4 = new RpcDecoder()
const unicode = encodeRpcMessage({ message: 'café ☕ 日本語' })
const uniOut = d4.push(unicode)
check(
  'RpcDecoder is byte-accurate for multibyte UTF-8',
  uniOut.length === 1 && (uniOut[0] as { message?: string }).message === 'café ☕ 日本語'
)

check('parseContentLength reads the value', parseContentLength('Content-Length: 42\r\n') === 42)
check('parseContentLength is case-insensitive', parseContentLength('content-length: 5') === 5)
check('parseContentLength returns null when absent', parseContentLength('Content-Type: x') === null)

// Server registry: extension → server.
check('serverForPath .ts → typescript', serverForPath('src/a.ts')?.id === 'typescript')
check('serverForPath .tsx → typescript', serverForPath('a.tsx')?.id === 'typescript')
check('serverForPath .py → pyright', serverForPath('a.py')?.id === 'pyright')
check('serverForPath .go → gopls', serverForPath('main.go')?.id === 'gopls')
check('serverForPath .rs → rust-analyzer', serverForPath('lib.rs')?.id === 'rust-analyzer')
check('serverForPath unsupported → undefined', serverForPath('README.md') === undefined)
check('serverForPath extensionless → undefined', serverForPath('Makefile') === undefined)

check('extname lowercases', lspExtname('A.TS') === '.ts')
check('extname handles no extension', lspExtname('Dockerfile') === '')
check('extname ignores dotfiles', lspExtname('.gitignore') === '')

check('languageIdForPath .ts', languageIdForPath('a.ts') === 'typescript')
check('languageIdForPath .tsx', languageIdForPath('a.tsx') === 'typescriptreact')
check('languageIdForPath .py', languageIdForPath('a.py') === 'python')
check('languageIdForPath unknown → plaintext', languageIdForPath('a.md') === 'plaintext')

// file:// URI round-trips, including spaces and unicode.
for (const p of ['/tmp/a.ts', '/tmp/my project/file b.ts', '/tmp/café/日本.ts']) {
  const uri = pathToFileUri(p)
  check(`pathToFileUri(${p}) is a file:// URI`, uri.startsWith('file:///'))
  check(`fileUriToPath round-trips ${p}`, fileUriToPath(uri) === p)
}
check('pathToFileUri encodes spaces', pathToFileUri('/a b/c').includes('%20'))

// Diagnostic rendering.
const errDiag: LspDiagnostic = {
  range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
  severity: 1,
  message: 'Cannot find name x',
  source: 'ts'
}
const warnDiag: LspDiagnostic = {
  range: { start: { line: 9, character: 0 }, end: { line: 9, character: 3 } },
  severity: 2,
  message: 'unused var'
}
check('severityLabel error', severityLabel(1) === 'ERROR')
check('severityLabel warning', severityLabel(2) === 'WARN')
check('severityLabel default (undefined) → ERROR', severityLabel(undefined) === 'ERROR')
check(
  'prettyDiagnostic is 1-based with source',
  prettyDiagnostic(errDiag) === 'ERROR [5:3] Cannot find name x (ts)'
)

const errBlock = renderDiagnosticsBlock('src/a.ts', [errDiag, warnDiag])
check(
  'renderDiagnosticsBlock wraps in a diagnostics tag',
  errBlock.startsWith('<diagnostics file="src/a.ts">')
)
check('renderDiagnosticsBlock shows errors by default', errBlock.includes('ERROR [5:3]'))
check('renderDiagnosticsBlock hides warnings by default', !errBlock.includes('unused var'))
check(
  'renderDiagnosticsBlock clean file → empty string',
  renderDiagnosticsBlock('x.ts', [warnDiag]) === ''
)
check(
  'renderDiagnosticsBlock includeWarnings surfaces warnings',
  renderDiagnosticsBlock('x.ts', [warnDiag], { includeWarnings: true }).includes('WARN [10:1]')
)
const many: LspDiagnostic[] = Array.from({ length: 25 }, (_, i) => ({
  range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
  severity: 1,
  message: `e${i}`
}))
const capped = renderDiagnosticsBlock('x.ts', many, { max: 20 })
check('renderDiagnosticsBlock caps at max with a "more" suffix', capped.includes('... and 5 more'))
check(
  'renderDiagnosticsBlock sorts by position',
  renderDiagnosticsBlock('x.ts', [
    {
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
      severity: 1,
      message: 'later'
    },
    {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
      severity: 1,
      message: 'earlier'
    }
  ]).indexOf('earlier') <
    renderDiagnosticsBlock('x.ts', [
      {
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } },
        severity: 1,
        message: 'later'
      },
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
        severity: 1,
        message: 'earlier'
      }
    ]).indexOf('later')
)

// ---- MCP: config normalize, tool-name namespacing, schema/result conv (Phase 13) ----

// normalizeServerConfig: local from a command array / string+args; remote from url.
check(
  'mcp cfg: local from command array',
  JSON.stringify(normalizeServerConfig({ command: ['node', 'x.js'] })) ===
    JSON.stringify({ type: 'local', command: ['node', 'x.js'] })
)
const localStrCmd = normalizeServerConfig({ command: 'node', args: ['x.js'] })
check(
  'mcp cfg: local from command string + args',
  localStrCmd?.type === 'local' &&
    JSON.stringify((localStrCmd as { command: string[] }).command) ===
      JSON.stringify(['node', 'x.js'])
)
check(
  'mcp cfg: remote inferred from url',
  JSON.stringify(normalizeServerConfig({ url: 'https://e.com/mcp' })) ===
    JSON.stringify({ type: 'remote', url: 'https://e.com/mcp' })
)
check(
  'mcp cfg: explicit type honored',
  normalizeServerConfig({ type: 'remote', url: 'https://e.com' })?.type === 'remote'
)
const localEnv = normalizeServerConfig({ command: ['x'], env: { A: '1' }, timeout: '5000' })
check(
  'mcp cfg: env alias + timeout coercion',
  localEnv?.type === 'local' &&
    (localEnv as { environment?: Record<string, string>; timeout?: number }).environment?.A ===
      '1' &&
    (localEnv as { timeout?: number }).timeout === 5000
)
check(
  'mcp cfg: null/empty/garbage → null',
  normalizeServerConfig(null) === null &&
    normalizeServerConfig({}) === null &&
    normalizeServerConfig({ command: [] }) === null &&
    normalizeServerConfig({ url: '' }) === null
)

// normalizeServerRecords: `{name: config}` map with disabled/enabled honored.
const recs = normalizeServerRecords({
  a: { command: ['x'], disabled: true },
  b: { url: 'https://e.com' },
  bad: {},
  c: { command: ['y'], enabled: false }
})
check(
  'mcp recs: parses valid entries, skips bad',
  recs.length === 3 && recs.map((r) => r.id).join(',') === 'a,b,c'
)
check('mcp recs: disabled:true → enabled:false', recs.find((r) => r.id === 'a')?.enabled === false)
check('mcp recs: url entry enabled by default', recs.find((r) => r.id === 'b')?.enabled === true)
check('mcp recs: enabled:false honored', recs.find((r) => r.id === 'c')?.enabled === false)
check(
  'mcp recs: non-object → []',
  normalizeServerRecords(null).length === 0 && normalizeServerRecords([]).length === 0
)

// qualifyToolName / isMcpToolName: provider-legal, namespaced, collision-resistant.
check(
  'mcp name: qualifies as mcp__server__tool',
  qualifyToolName('srv', 'tool') === 'mcp__srv__tool'
)
check(
  'mcp name: sanitizes illegal chars',
  qualifyToolName('my server', 'do/it') === 'mcp__my_server__do_it'
)
check('mcp name: prefix constant', MCP_TOOL_PREFIX === 'mcp')
check('sanitizeNamePart replaces illegal chars', sanitizeNamePart('a b/c.d') === 'a_b_c_d')
const longA = qualifyToolName('server', 'x'.repeat(80))
const longB = qualifyToolName('server', 'y'.repeat(80))
check(
  'mcp name: overlong truncated to <= MAX_TOOL_NAME',
  longA.length <= MAX_TOOL_NAME && longA.startsWith('mcp__server__')
)
check('mcp name: distinct long names stay distinct (hash)', longA !== longB)
check(
  'isMcpToolName: true for namespaced, false otherwise',
  isMcpToolName('mcp__x__y') && !isMcpToolName('read') && !isMcpToolName('mcpx')
)

// mcpToolToSchema: guarantees an object schema; falls back on description.
const sch = mcpToolToSchema('mcp__s__t', 'desc', {
  type: 'object',
  properties: { a: { type: 'string' } }
})
check(
  'mcp schema: name + description + object params',
  sch.type === 'function' &&
    sch.function.name === 'mcp__s__t' &&
    sch.function.description === 'desc' &&
    sch.function.parameters.type === 'object' &&
    !!(sch.function.parameters.properties as Record<string, unknown>).a
)
check(
  'mcp schema: empty description → fallback names the tool',
  (mcpToolToSchema('mcp__s__t', '  ', {}).function.description ?? '').includes('mcp__s__t')
)
check(
  'mcp schema: non-object inputSchema → {type:object,properties:{}}',
  JSON.stringify(mcpToolToSchema('mcp__s__t', 'd', 'nope').function.parameters) ===
    JSON.stringify({ type: 'object', properties: {} })
)
check(
  'mcp schema: missing properties gets an empty map',
  JSON.stringify(
    (
      mcpToolToSchema('mcp__s__t', 'd', { type: 'object' }).function.parameters as {
        properties: unknown
      }
    ).properties
  ) === JSON.stringify({})
)

// renderMcpContent: text join, image data-url, resource, error mapping.
const rText = renderMcpContent(
  [
    { type: 'text', text: 'hello' },
    { type: 'text', text: 'world' }
  ],
  false
)
check('mcp render: text blocks joined, ok:true', rText.ok && rText.output === 'hello\nworld')
const rImg = renderMcpContent([{ type: 'image', data: 'AAA', mimeType: 'image/png' }], false)
check(
  'mcp render: image → data URL + [image] marker',
  rImg.image === 'data:image/png;base64,AAA' && rImg.output.includes('[image: image/png]')
)
check(
  'mcp render: resource with text uses the text',
  renderMcpContent([{ type: 'resource', resource: { uri: 'file://x', text: 'body' } }], false)
    .output === 'body'
)
check(
  'mcp render: resource without text → uri pointer',
  renderMcpContent([{ type: 'resource', resource: { uri: 'file://x' } }], false).output.includes(
    '[resource: file://x]'
  )
)
const rErr = renderMcpContent([{ type: 'text', text: 'bad' }], true)
check('mcp render: isError → ok:false', !rErr.ok && rErr.output === 'bad')
check(
  'mcp render: empty content → placeholder',
  renderMcpContent([], false).output === '(no output)' && renderMcpContent([], false).ok
)
check(
  'mcp render: empty error → error placeholder',
  !renderMcpContent([], true).ok && renderMcpContent([], true).output.includes('error')
)

// describeMcpForPrompt: only connected servers; undefined when none.
const sums: McpServerSummary[] = [
  { id: 'files', status: 'connected', tools: ['read_file', 'write_file'] },
  { id: 'down', status: 'error', tools: [], error: 'x' }
]
const blurb = describeMcpForPrompt(sums)
check(
  'mcp prompt: lists connected servers + tools + namespacing',
  !!blurb &&
    blurb.includes('files') &&
    blurb.includes('read_file') &&
    blurb.includes('mcp__<server>__<tool>')
)
check('mcp prompt: excludes non-connected servers', !!blurb && !blurb.includes('down'))
check(
  'mcp prompt: undefined when nothing connected',
  describeMcpForPrompt([{ id: 'd', status: 'disabled', tools: [] }]) === undefined &&
    describeMcpForPrompt([]) === undefined
)

// ---- Skills: frontmatter parse, prompt block, tool-output render (Phase 14) ----
check(
  'skill: constants',
  SKILL_TOOL_NAME === 'skill' &&
    SKILL_FILE_SAMPLE_LIMIT === 10 &&
    SKILL_TOOL_DESCRIPTION.includes('skill')
)

// parseSkillFrontmatter: happy path — scalar keys + body split.
const fmA = parseSkillFrontmatter(
  '---\nname: pdf\ndescription: Fill PDF forms\n---\nDo the thing.\n'
)
check(
  'skill fm: reads name + description',
  fmA.data.name === 'pdf' && fmA.data.description === 'Fill PDF forms'
)
check('skill fm: strips frontmatter from body', fmA.body.trim() === 'Do the thing.')

// No frontmatter → empty map, full body (BOM stripped).
const fmNone = parseSkillFrontmatter('\uFEFFjust a body, no matter')
check(
  'skill fm: no frontmatter → empty data + body',
  Object.keys(fmNone.data).length === 0 && fmNone.body === 'just a body, no matter'
)

// Quotes stripped; a colon inside a quoted value is preserved (first colon splits).
const fmQuote = parseSkillFrontmatter(
  '---\nname: "my skill"\ndescription: "Ratio 3:2 export"\n---\nx'
)
check('skill fm: surrounding quotes stripped', fmQuote.data.name === 'my skill')
check('skill fm: colon in value preserved', fmQuote.data.description === 'Ratio 3:2 export')

// List items, nested lines, comments, and block scalars are skipped (no YAML dep).
const fmList = parseSkillFrontmatter(
  '---\nname: x\n# a comment\nreferences:\n  - a.md\n  - b.md\nbody: |\n---\nB'
)
check(
  'skill fm: skips list/nested/comment/block-scalar',
  fmList.data.name === 'x' && !('references' in fmList.data) && !('body' in fmList.data)
)

// CRLF frontmatter is handled.
const fmCrlf = parseSkillFrontmatter('---\r\nname: crlf\r\n---\r\nbody')
check('skill fm: CRLF frontmatter', fmCrlf.data.name === 'crlf' && fmCrlf.body === 'body')

// describeSkillsForPrompt: verbose <available_skills> block, escaping, undefined-when-empty.
const skA: SkillInfo = {
  name: 'pdf',
  description: 'Fill & sign',
  location: '/s/pdf/SKILL.md',
  content: 'body',
  source: 'workspace'
}
const skB: SkillInfo = {
  name: 'aws',
  location: '/g/aws/SKILL.md',
  content: 'body',
  source: 'global'
}
const promptBlock = describeSkillsForPrompt([skB, skA])
check(
  'skill prompt: wraps in <available_skills>',
  !!promptBlock &&
    promptBlock.includes('<available_skills>') &&
    promptBlock.includes('</available_skills>')
)
check(
  'skill prompt: sorted by name (pdf after aws)',
  !!promptBlock && promptBlock.indexOf('<name>aws</name>') < promptBlock.indexOf('<name>pdf</name>')
)
check(
  'skill prompt: lists name + location',
  !!promptBlock &&
    promptBlock.includes('<name>pdf</name>') &&
    promptBlock.includes('/s/pdf/SKILL.md')
)
check(
  'skill prompt: escapes XML in description',
  !!describeSkillsForPrompt([
    { name: 'x', description: 'a & b <c>', location: '/x', content: '', source: 'global' }
  ])?.includes('a &amp; b &lt;c&gt;')
)
check(
  'skill prompt: omits <description> when absent',
  !!promptBlock && promptBlock.includes('<name>aws</name>\n    <location>')
)
check('skill prompt: undefined when empty', describeSkillsForPrompt([]) === undefined)

// serializeSkillMarkdown ↔ parseSkillFrontmatter round-trip (the authoring path).
const rtParsed = parseSkillFrontmatter(
  serializeSkillMarkdown('release-notes', 'Draft the release notes', '# Steps\nDo it.\n')
)
check('skill serialize: round-trips name', rtParsed.data.name === 'release-notes')
check(
  'skill serialize: round-trips description',
  rtParsed.data.description === 'Draft the release notes'
)
check(
  'skill serialize: round-trips body',
  rtParsed.body.includes('# Steps') && rtParsed.body.includes('Do it.')
)
// A description with a colon still round-trips (unquoted, split-on-first-colon).
const rtColon = parseSkillFrontmatter(serializeSkillMarkdown('x', 'Ratio 3:2 export', 'B'))
check(
  'skill serialize: colon in description survives',
  rtColon.data.description === 'Ratio 3:2 export'
)
// A leading-special description gets quoted and still recovers.
const rtQuoted = parseSkillFrontmatter(serializeSkillMarkdown('y', '#hashy value', 'B'))
check(
  'skill serialize: special-lead description survives',
  rtQuoted.data.description === '#hashy value'
)
// Missing description → no description key, body still intact.
const rtNoDesc = parseSkillFrontmatter(serializeSkillMarkdown('z', undefined, 'Body only'))
check(
  'skill serialize: omits empty description',
  rtNoDesc.data.description === undefined && rtNoDesc.body.includes('Body only')
)

// isValidSkillName: accepts safe names, rejects spaces / slashes / traversal.
check('skill name: accepts a normal name', isValidSkillName('release-notes.v2'))
check('skill name: rejects spaces', !isValidSkillName('bad name'))
check('skill name: rejects slashes', !isValidSkillName('a/b'))
check('skill name: rejects traversal', !isValidSkillName('..'))
check('skill name: rejects empty', !isValidSkillName(''))

// renderSkillContent: instructions + base dir; companion files only when present.
const rendered = renderSkillContent({ name: 'pdf', content: '  # How\nSteps.  ' }, '/s/pdf', [
  'scripts/fill.py',
  'reference/spec.md'
])
check(
  'skill render: wraps in <skill_content>',
  rendered.includes('<skill_content name="pdf">') && rendered.trimEnd().endsWith('</skill_content>')
)
check(
  'skill render: trims body + states base dir',
  rendered.includes('Steps.') && rendered.includes('Base directory for this skill: /s/pdf')
)
check(
  'skill render: lists sampled files',
  rendered.includes('<skill_files>') && rendered.includes('<file>scripts/fill.py</file>')
)
const renderedNoFiles = renderSkillContent({ name: 'x', content: 'B' }, '/s/x', [])
check('skill render: no <skill_files> when none', !renderedNoFiles.includes('<skill_files>'))

// resolveSkillSource: classify install sources (Roxy's `npx skills add`).
const rsRepo = resolveSkillSource('vercel-labs/agent-skills')
check(
  'skill src: owner/repo shorthand → github-repo',
  rsRepo.kind === 'github-repo' && rsRepo.owner === 'vercel-labs' && rsRepo.repo === 'agent-skills'
)
const rsRepoUrl = resolveSkillSource('https://github.com/vercel-labs/agent-skills')
check(
  'skill src: github repo URL → github-repo',
  rsRepoUrl.kind === 'github-repo' && rsRepoUrl.repo === 'agent-skills'
)
const rsGit = resolveSkillSource('https://github.com/vercel-labs/agent-skills.git')
check(
  'skill src: .git suffix stripped',
  rsGit.kind === 'github-repo' && rsGit.repo === 'agent-skills'
)
const rsTree = resolveSkillSource(
  'https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines'
)
check(
  'skill src: /tree/<ref>/<path> → github-dir with ref+path',
  rsTree.kind === 'github-dir' &&
    rsTree.ref === 'main' &&
    rsTree.path === 'skills/web-design-guidelines'
)
const rsBlob = resolveSkillSource('https://github.com/o/r/blob/main/skills/hello/SKILL.md')
check(
  'skill src: /blob/<ref>/<path>.md → github-file',
  rsBlob.kind === 'github-file' && rsBlob.ref === 'main' && rsBlob.path === 'skills/hello/SKILL.md'
)
const rsShortPath = resolveSkillSource('o/r/skills/hello')
check(
  'skill src: owner/repo/sub/dir → github-dir (default branch)',
  rsShortPath.kind === 'github-dir' &&
    rsShortPath.path === 'skills/hello' &&
    rsShortPath.ref === undefined
)
const rsScp = resolveSkillSource('git@github.com:o/r.git')
check(
  'skill src: git@github SCP URL → github-repo',
  rsScp.kind === 'github-repo' && rsScp.owner === 'o' && rsScp.repo === 'r'
)
const rsRaw = resolveSkillSource('https://raw.githubusercontent.com/o/r/main/solo/SKILL.md')
check('skill src: raw .md URL → raw-md', rsRaw.kind === 'raw-md')
const rsRawNoMd = resolveSkillSource('https://raw.githubusercontent.com/o/r/main/dir')
check('skill src: raw non-.md URL → unsupported', rsRawNoMd.kind === 'unsupported')
const rsGitlab = resolveSkillSource('https://gitlab.com/o/r')
check(
  'skill src: gitlab → unsupported (friendly)',
  rsGitlab.kind === 'unsupported' && /gitlab/i.test((rsGitlab as { reason: string }).reason)
)
const rsLocal = resolveSkillSource('./my-skills')
check('skill src: local path → unsupported', rsLocal.kind === 'unsupported')
const rsEmpty = resolveSkillSource('   ')
check('skill src: empty → unsupported', rsEmpty.kind === 'unsupported')
const rsTraversal = resolveSkillSource('../evil/repo')
check('skill src: traversal owner → unsupported', rsTraversal.kind === 'unsupported')

// sanitizeSkillName: derive a valid skill id from arbitrary frontmatter/folder names.
check(
  'skill sanitize: spaces → dashes',
  sanitizeSkillName('Web Design Guidelines') === 'web-design-guidelines'
)
check(
  'skill sanitize: strips leading non-alnum',
  sanitizeSkillName('__weird--name') === 'weird--name'
)
check('skill sanitize: neutralizes ..', sanitizeSkillName('a..b') === 'a.b')
check('skill sanitize: empty/invalid → null', sanitizeSkillName('///') === null)
check('skill sanitize: caps length at 64', (sanitizeSkillName('a'.repeat(200)) ?? '').length === 64)

// ---- Git commit co-author trailer (Roxy attribution, mirrors Copilot) ----
console.log('\ngit commit co-author trailer\n')
// The identity line is a well-formed Co-authored-by trailer that names Roxy.
check(
  'coauthor: trailer is a Co-authored-by line',
  /^Co-authored-by: .+ <[^>]+@[^>]+>$/.test(ROXY_COAUTHOR_TRAILER)
)
check('coauthor: trailer names Roxy', /\bRoxy\b/.test(ROXY_COAUTHOR_TRAILER))
// Must use GitHub's <id>+<login>@users.noreply.github.com form so GitHub links the
// co-author to the @roxy-commits profile and renders its avatar (like Copilot's).
// A plain vanity address (e.g. noreply@roxy.gg) would render no avatar/link.
check(
  'coauthor: trailer uses a GitHub noreply email (avatar + linked profile)',
  /<\d+\+[^@>]+@users\.noreply\.github\.com>$/.test(ROXY_COAUTHOR_TRAILER)
)
// The prompt block wraps the trailer in <git_commit_trailer> tags and embeds the exact line.
check(
  'coauthor: prompt block is tagged',
  GIT_COMMIT_TRAILER_PROMPT.startsWith('<git_commit_trailer>') &&
    GIT_COMMIT_TRAILER_PROMPT.trimEnd().endsWith('</git_commit_trailer>')
)
check(
  'coauthor: prompt block embeds the exact trailer',
  GIT_COMMIT_TRAILER_PROMPT.includes(ROXY_COAUTHOR_TRAILER)
)
// The instruction is conditional so it never conflicts with "never commit unless asked".
check(
  'coauthor: instruction is conditional',
  /when you create a git commit/i.test(GIT_COMMIT_TRAILER_PROMPT) &&
    /unless the user/i.test(GIT_COMMIT_TRAILER_PROMPT)
)

// assembleSystemPrompt injects the block exactly once into every full prompt…
const asmFull = assembleSystemPrompt({
  base: 'BASE PROMPT',
  environment: buildEnvironment({ modelId: 'claude-sonnet-4', cwd: '/w' }),
  extra: ['AGENTS.md guidance'],
  contextSummary: 'earlier stuff'
})
check(
  'coauthor: assembled prompt includes the trailer block',
  asmFull.includes('<git_commit_trailer>')
)
check(
  'coauthor: assembled prompt includes the trailer line',
  asmFull.includes(ROXY_COAUTHOR_TRAILER)
)
check(
  'coauthor: trailer block appears exactly once',
  asmFull.split('<git_commit_trailer>').length - 1 === 1
)
// …and keeps the compaction summary last (the trailer sits above it).
check(
  'coauthor: trailer precedes the context summary',
  asmFull.indexOf('<git_commit_trailer>') < asmFull.indexOf('Summary of the earlier conversation')
)
// Even a minimal prompt (base only) still carries the attribution instruction.
check(
  'coauthor: minimal prompt still includes the trailer',
  assembleSystemPrompt({ base: 'ONLY BASE' }).includes(ROXY_COAUTHOR_TRAILER)
)

// selectPromptName sanity — the trailer rides on top of whichever family is picked.
check('prompt select: gpt-4 → beast', selectPromptName('gpt-4o') === 'beast')
check('prompt select: claude → anthropic', selectPromptName('claude-sonnet-4') === 'anthropic')
check('prompt select: unknown → default', selectPromptName('some-random-model') === 'default')

// ---- Remote Workspace IPC parity (Part 6) ----
// The remote:* channels span four files that must agree: the channel catalog
// (ipc.ts), the preload bridge (renderer surface), the main handlers/emitter,
// and the RoxyApi type. A drift in any one silently breaks "share to phone", so
// we assert the wiring statically from source — no Electron runtime needed.
console.log('\nremote workspace ipc parity\n')
{
  const root = process.cwd()
  const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
  const preload = read('src/preload/index.ts')
  const handlers = read('src/main/ipc/index.ts')
  const service = read('src/main/services/remote.ts')
  const api = read('src/shared/api.ts')
  // `remote` is the last member of both the preload bridge and RoxyApi, so
  // slicing from its marker to EOF isolates just that block for method checks.
  const preloadRemote = preload.slice(preload.indexOf('remote: {'))
  const apiRemote = api.slice(api.indexOf('remote: {'))

  // Channel string values are the contract both the client and roxy.gg encode.
  check('remote:start channel value', CHANNELS.remoteStart === 'remote:start')
  check('remote:stop channel value', CHANNELS.remoteStop === 'remote:stop')
  check('remote:status channel value', CHANNELS.remoteStatus === 'remote:status')
  check('remote:state channel value', CHANNELS.remoteState === 'remote:state')
  check('remote:delta channel value', CHANNELS.remoteDelta === 'remote:delta')

  // Each invoke channel is wired end-to-end: preload bridge + a main handler.
  for (const key of ['remoteStart', 'remoteStop', 'remoteStatus'] as const) {
    check(`preload bridges CHANNELS.${key}`, preload.includes(`CHANNELS.${key}`))
    check(`main handles CHANNELS.${key}`, handlers.includes(`ipcMain.handle(CHANNELS.${key}`))
  }

  // The push event: preload subscribes *and* unsubscribes; main emits it.
  check(
    'preload subscribes to remote:state',
    preload.includes('ipcRenderer.on(CHANNELS.remoteState')
  )
  check(
    'preload unsubscribes from remote:state',
    preload.includes('removeListener(CHANNELS.remoteState')
  )
  check('main emits remote:state', service.includes('CHANNELS.remoteState'))

  // The live-stream push: preload subscribes *and* unsubscribes; main emits it.
  check(
    'preload subscribes to remote:delta',
    preload.includes('ipcRenderer.on(CHANNELS.remoteDelta')
  )
  check(
    'preload unsubscribes from remote:delta',
    preload.includes('removeListener(CHANNELS.remoteDelta')
  )
  check('main emits remote:delta', service.includes('CHANNELS.remoteDelta'))

  // window.roxy.remote.* must match the RoxyApi type surface exactly.
  check('preload exposes remote.start', /\bstart:/.test(preloadRemote))
  check('preload exposes remote.stop', /\bstop:/.test(preloadRemote))
  check('preload exposes remote.status', /\bstatus:/.test(preloadRemote))
  check('preload exposes remote.onState', /\bonState:/.test(preloadRemote))
  check('preload exposes remote.onDelta', /\bonDelta:/.test(preloadRemote))
  check('api declares remote.start', /\bstart\(/.test(apiRemote))
  check('api declares remote.stop', /\bstop\(/.test(apiRemote))
  check('api declares remote.status', /\bstatus\(/.test(apiRemote))
  check('api declares remote.onState', /\bonState\(/.test(apiRemote))
  check('api declares remote.onDelta', /\bonDelta\(/.test(apiRemote))
}

async function main(): Promise<void> {
  // mapWithConcurrency: empty input is a no-op empty array.
  check(
    'mapWithConcurrency([]) is empty',
    (await mapWithConcurrency([], 4, async () => 1)).length === 0
  )

  // Results come back in INPUT order even when later items resolve first.
  const orderOut = await mapWithConcurrency([30, 10, 20, 0], 4, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms))
    return `${i}:${ms}`
  })
  check('mapWithConcurrency preserves input order', orderOut.join() === '0:30,1:10,2:20,3:0')

  // Bounded: never more than `limit` run at once, and it genuinely parallelizes.
  let active = 0
  let peak = 0
  const items = Array.from({ length: 12 }, (_, i) => i)
  const out = await mapWithConcurrency(items, 3, async (i) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 5))
    active--
    return i * 2
  })
  check('mapWithConcurrency respects the limit', peak <= 3)
  check('mapWithConcurrency actually parallelizes', peak >= 2)
  check('mapWithConcurrency maps every value', out.join() === items.map((i) => i * 2).join())

  // A limit larger than the batch is clamped (no idle workers, all run).
  const small = await mapWithConcurrency([1, 2], 10, async (n) => n + 1)
  check('mapWithConcurrency clamps limit to batch size', small.join() === '2,3')

  // --- session slugs (npm-style random three-word session names) ---
  const slugs = Array.from({ length: 500 }, () => randomSlug())
  check(
    'randomSlug returns three words',
    slugs.every((s) => s.trim().split(/\s+/).length === 3)
  )
  check(
    'randomSlug words are Capitalized',
    slugs.every((s) => s.split(' ').every((w) => /^[A-Z][a-z]+$/.test(w)))
  )
  check(
    'randomSlug never repeats noun as role',
    slugs.every((s) => {
      const [, noun, role] = s.split(' ')
      return noun !== role
    })
  )
  check('randomSlug is well-distributed', new Set(slugs).size > 100)

  const seed = randomSlug()
  const fresh = uniqueSlug([seed.toLowerCase()])
  check('uniqueSlug avoids a taken name', fresh.toLowerCase() !== seed.toLowerCase())
  check('uniqueSlug with no taken set still returns a slug', uniqueSlug().split(/\s+/).length >= 3)

  // --- formatInterval (loop heartbeat labels: m → hrs → days) ---
  check('formatInterval sub-hour stays minutes', formatInterval(5) === '5m')
  check('formatInterval 59m stays minutes', formatInterval(59) === '59m')
  check('formatInterval 60m is 1hr', formatInterval(60) === '1hr')
  check('formatInterval 90m is 1hr 30m', formatInterval(90) === '1hr 30m')
  check('formatInterval 120m is 2hrs', formatInterval(120) === '2hrs')
  check('formatInterval 360m is 6hrs', formatInterval(360) === '6hrs')
  check('formatInterval 1439m is 23hrs 59m', formatInterval(1439) === '23hrs 59m')
  check('formatInterval 1440m is 1 day', formatInterval(1440) === '1 day')
  check('formatInterval 2880m is 2 days', formatInterval(2880) === '2 days')
  check('formatInterval 1500m is 1 day 1hr', formatInterval(1500) === '1 day 1hr')
  check('formatInterval clamps sub-minute to 1m', formatInterval(0) === '1m')

  // ---- portable config bundle (export/import global skills + MCP) ----
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
  const goodBundle = buildBundle({
    now: 1720000000000,
    app: '9.9.9',
    skills: [
      {
        name: 'demokit',
        files: [
          { path: 'SKILL.md', dataBase64: b64('---\nname: demokit\n---\nHi') },
          { path: 'scripts/run.sh', dataBase64: b64('echo hi') }
        ]
      }
    ],
    mcpServers: [
      { id: 'filesystem', config: { type: 'local', command: ['npx', 'x'] }, enabled: true },
      { id: 'remote1', config: { type: 'remote', url: 'https://e.com/mcp' }, enabled: false }
    ]
  })
  check(
    'portable: buildBundle stamps kind + version',
    goodBundle.kind === BUNDLE_KIND && goodBundle.version === BUNDLE_VERSION
  )
  check('portable: buildBundle keeps the injected clock', goodBundle.exportedAt === 1720000000000)
  check(
    'portable: buildBundle carries skills + servers',
    goodBundle.skills.length === 1 && goodBundle.mcpServers.length === 2
  )
  check(
    'portable: summarizeBundle reads naturally',
    summarizeBundle(goodBundle) === '1 skill, 2 MCP servers'
  )

  const roundTrip = parseBundle(serializeBundle(goodBundle))
  check('portable: serialize -> parse round-trips', roundTrip.ok === true)
  if (roundTrip.ok) {
    check(
      'portable: round-trip preserves the skill file',
      roundTrip.bundle.skills[0].files.length === 2
    )
    check(
      'portable: round-trip preserves a disabled server',
      roundTrip.bundle.mcpServers.find((s) => s.id === 'remote1')?.enabled === false
    )
  }

  // Rejections
  check('portable: parse rejects non-JSON', parseBundle('not json').ok === false)
  check(
    'portable: parse rejects the wrong kind',
    parseBundle('{"kind":"nope","version":1}').ok === false
  )
  check(
    'portable: parse rejects a future version',
    parseBundle(JSON.stringify({ kind: BUNDLE_KIND, version: 999, skills: [], mcpServers: [] }))
      .ok === false
  )
  check(
    'portable: parse rejects an empty bundle',
    parseBundle(JSON.stringify({ kind: BUNDLE_KIND, version: 1, skills: [], mcpServers: [] }))
      .ok === false
  )

  // A skill with no SKILL.md is dropped; unsafe companion paths are dropped.
  const dirty = parseBundle(
    JSON.stringify({
      kind: BUNDLE_KIND,
      version: 1,
      skills: [
        { name: 'noskillmd', files: [{ path: 'notes.txt', dataBase64: b64('x') }] },
        {
          name: 'ok',
          files: [
            { path: 'SKILL.md', dataBase64: b64('hi') },
            { path: '../escape.sh', dataBase64: b64('bad') },
            { path: '/abs.sh', dataBase64: b64('bad') }
          ]
        }
      ],
      mcpServers: [
        { id: '', config: { type: 'remote', url: 'https://e.com' } },
        { id: 'bad', config: { nonsense: true } },
        { id: 'good', config: { url: 'https://ok.com/mcp' } }
      ]
    })
  )
  check(
    'portable: parse drops a skill missing SKILL.md',
    dirty.ok === true && dirty.bundle.skills.length === 1
  )
  check(
    'portable: parse strips unsafe companion paths (keeps only SKILL.md)',
    dirty.ok === true &&
      dirty.bundle.skills[0].files.length === 1 &&
      dirty.bundle.skills[0].files[0].path === 'SKILL.md'
  )
  check(
    'portable: parse keeps only the valid MCP server',
    dirty.ok === true &&
      dirty.bundle.mcpServers.length === 1 &&
      dirty.bundle.mcpServers[0].id === 'good'
  )
  check(
    'portable: parse infers MCP transport from url',
    dirty.ok === true && dirty.bundle.mcpServers[0].config.type === 'remote'
  )

  // isSafeSkillFilePath guards
  check('portable: safe path accepts a nested companion', isSafeSkillFilePath('scripts/run.sh'))
  check('portable: safe path rejects ..', !isSafeSkillFilePath('../x'))
  check('portable: safe path rejects absolute', !isSafeSkillFilePath('/etc/passwd'))
  check('portable: safe path rejects a drive letter', !isSafeSkillFilePath('C:/x'))
  check('portable: safe path rejects backslashes', !isSafeSkillFilePath('a\\b'))

  // ---- subagent concurrency: readers parallel, writers serialized ----
  // Two write-capable subagents share their parent's cwd, so running them at
  // once is a file race inside one session. These assert real OVERLAP, not a
  // reimplementation of the rule.
  {
    check('explore is not write-capable', isWriteCapableSubagent('explore') === false)
    check('general IS write-capable', isWriteCapableSubagent('general') === true)
    // Fail closed: the default subagent is `general`, so an unknown name must
    // never be optimistically treated as safe to parallelize.
    check(
      'an unknown subagent is treated as write-capable',
      isWriteCapableSubagent('nope') === true
    )
    check('an empty subagent name is write-capable', isWriteCapableSubagent('') === true)

    const part = partitionTasksByWriteCapability(
      ['explore', 'general', 'explore', 'general'],
      (t) => isWriteCapableSubagent(t)
    )
    check(
      'partition splits readers from writers',
      part.readers.length === 2 && part.writers.length === 2
    )

    /**
     * Run tasks, recording the max number of the SAME KIND in flight at once.
     * Per-kind matters: the rule is "no two writers overlap", not "a writer
     * never overlaps anything" — writers are expected to run alongside readers.
     */
    const trace = async (kinds: string[]) => {
      const live = new Map<string, number>()
      const peak = new Map<string, number>()
      const order: string[] = []
      const results = await runTasksByWriteCapability(kinds, {
        isWriteCapable: (t) => isWriteCapableSubagent(t),
        limit: 4,
        run: async (t) => {
          const now = (live.get(t) ?? 0) + 1
          live.set(t, now)
          peak.set(t, Math.max(peak.get(t) ?? 0, now))
          order.push(t)
          await new Promise((r) => setTimeout(r, 20))
          live.set(t, now - 1)
          return `done:${t}`
        }
      })
      return { peak, order, results }
    }

    // Writers must never overlap...
    const w = await trace(['general', 'general', 'general'])
    check(
      'two write-capable subagents never overlap',
      (w.peak.get('general') ?? 0) === 1,
      String(w.peak.get('general'))
    )
    check('...and all of them still run', w.results.length === 3)
    check('...in their original order', w.order.join(',') === 'general,general,general')

    // ...while readers still do.
    const r = await trace(['explore', 'explore', 'explore'])
    check(
      'read-only subagents DO overlap',
      (r.peak.get('explore') ?? 0) > 1,
      String(r.peak.get('explore'))
    )
    check('...and all of them run', r.results.length === 3)

    // Mixed: readers fan out, the single writer is unaffected.
    const m = await trace(['explore', 'general', 'explore', 'general'])
    check('mixed turn: readers still overlap', (m.peak.get('explore') ?? 0) > 1)
    check('mixed turn: writers still do not', (m.peak.get('general') ?? 0) === 1)
    // Writers are not blocked BY readers — serialization is writer-vs-writer
    // only, so a slow explore never stalls the editing work.
    {
      let liveReaders = 0
      let sawOverlap = false
      await runTasksByWriteCapability(['explore', 'explore', 'general', 'general'], {
        isWriteCapable: (t) => isWriteCapableSubagent(t),
        limit: 4,
        run: async (t) => {
          const reader = t === 'explore'
          if (reader) liveReaders++
          else if (liveReaders > 0) sawOverlap = true
          await new Promise((r) => setTimeout(r, 20))
          if (reader) liveReaders--
          return t
        }
      })
      check('mixed turn: a writer runs while readers are still in flight', sawOverlap)
    }
    check('mixed turn: every task returns a result', m.results.length === 4)
    check(
      'mixed turn: results carry their task back',
      m.results.every((x) => x.result === `done:${x.task}`)
    )

    // Abort stops LAUNCHING more writers, but keeps what already finished so the
    // caller can still pair every tool_call with a tool result.
    {
      let ran = 0
      let abort = false
      const out = await runTasksByWriteCapability(['general', 'general', 'general'], {
        isWriteCapable: () => true,
        limit: 4,
        aborted: () => abort,
        run: async () => {
          ran++
          abort = true // cancel the turn after the first one
          return ran
        }
      })
      check('abort stops launching further writers', ran === 1, String(ran))
      check('...but keeps the result that already completed', out.length === 1)
    }

    check(
      'no tasks -> no results',
      (
        await runTasksByWriteCapability([], {
          isWriteCapable: () => true,
          limit: 4,
          run: async () => 1
        })
      ).length === 0
    )
  }

  // ---- workstream strip visibility rules ----
  // Every rule here is a visible bug when it's wrong: a strip that flashes and
  // vanishes, a sub-session offering a dropdown that would move its parent's
  // tree, or a permanent greyed-out row in every non-git folder.
  {
    const mk = (over: Partial<StripSession> = {}): StripSession => ({
      id: 's1',
      title: 'auth work',
      kind: 'main',
      parentId: null,
      workspacePath: '/proj',
      worktreePath: null,
      branch: null,
      ...over
    })
    const repoStatus = { isRepo: true, branch: 'main', dirty: false, changed: 0 }
    const NO_STATUS = 'none' as const
    const view = (
      chat: StripSession | null,
      status: typeof repoStatus | typeof NO_STATUS = repoStatus,
      gitAvailable: boolean | null = true,
      all: StripSession[] = []
    ) =>
      workstreamStripView({
        chat,
        findChat: (id) => all.find((c) => c.id === id) ?? null,
        gitAvailable,
        status: status === NO_STATUS ? undefined : status
      })

    check('strip: hidden with no session', view(null) === null)
    check('strip: hidden when git is unavailable', view(mk(), repoStatus, false) === null)
    check(
      'strip: hidden when the folder has no workspace',
      view(mk({ workspacePath: null })) === null
    )
    check('strip: hidden before the first status lands', view(mk(), NO_STATUS) === null)
    check(
      'strip: hidden when the folder is not a repo',
      view(mk(), { isRepo: false, branch: null, dirty: false, changed: 0 }) === null
    )
    // Probing (null) must not hide it permanently once status says it's a repo.
    check(
      'strip: shows while git availability is still unknown',
      view(mk(), repoStatus, null) !== null
    )

    const plain = view(mk())
    check('strip: default workstream is labelled as such', plain?.label === 'default workstream')
    check('strip: falls back to the git branch', plain?.branch === 'main')
    check('strip: default workstream polls the project folder', plain?.statusKey === '/proj')
    check('strip: a main session gets the dropdown', plain?.readOnly === false)
    check('strip: default workstream is not in a worktree', plain?.inWorktree === false)

    const wt = view(mk({ worktreePath: '/wt/auth', branch: 'roxy/auth' }))
    check('strip: a worktree session is labelled by its title', wt?.label === 'auth work')
    check('strip: ...and shows its own branch', wt?.branch === 'roxy/auth')
    check('strip: ...and polls by WORKTREE path', wt?.statusKey === '/wt/auth')
    check('strip: ...and is flagged in-worktree', wt?.inWorktree === true)

    // A sub-session shows its PARENT's workstream, read-only — acting on it
    // would move the parent's tree out from under it.
    const parent = mk({ id: 'p1', worktreePath: '/wt/auth', branch: 'roxy/auth' })
    const sub = mk({ id: 'sub1', kind: 'sub', parentId: 'p1', workspacePath: null })
    const subView = view(sub, repoStatus, true, [parent, sub])
    check('strip: a sub-session shows its parent workstream', subView?.label === 'auth work')
    check('strip: ...owned by the parent', subView?.ownerId === 'p1')
    check('strip: ...read-only (no dropdown)', subView?.readOnly === true)
    check('strip: an orphaned sub renders nothing', view(sub, repoStatus, true, [sub]) === null)

    const dirty = view(mk(), { isRepo: true, branch: 'main', dirty: true, changed: 3 })
    check('strip: surfaces the dirty flag', dirty?.dirty === true)

    // Polling keys: N sessions on one worktree share a single poll, and subs
    // never poll separately from their parent.
    check('poll key: default workstream -> project folder', statusKeyForSession(mk()) === '/proj')
    check(
      'poll key: worktree session -> worktree path',
      statusKeyForSession(mk({ worktreePath: '/wt/auth' })) === '/wt/auth'
    )
    check('poll key: a sub-session never polls', statusKeyForSession(sub) === null)
  }

  // ---- <env> dev port (parallel sessions must not fight over :3000) ----
  {
    const withPort = buildEnvironment({ cwd: '/w', devPort: 3101 })
    check(
      'buildEnvironment states the dev port',
      withPort.includes('Dev server port: 3101'),
      withPort
    )
    check(
      'the port line tells the model other sessions own others',
      /other sessions own other ports/.test(withPort)
    )
    // PORT alone is not enough (vite.config.ts etc. hardcode a port), but a
    // session WITHOUT one must not get a misleading line.
    check('no port -> no port line', !buildEnvironment({ cwd: '/w' }).includes('Dev server port'))
    check(
      'port 0 is not emitted',
      !buildEnvironment({ cwd: '/w', devPort: 0 }).includes('Dev server port')
    )
  }

  // ---- resolveWorktreeCwd (worktree path math) ----
  // Exercised against BOTH path flavours: Roxy ships on Windows and posix, and
  // the repo-subfolder case is where a naive join breaks.
  for (const [label, p] of [['posix', posixPath] as const, ['win32', win32Path] as const]) {
    const sep = label === 'win32' ? '\\' : '/'
    const root = label === 'win32' ? 'C:\\repo' : '/repo'
    const wt = label === 'win32' ? 'C:\\wt\\fix' : '/wt/fix'

    check(
      `resolveWorktreeCwd (${label}): no workspace -> ''`,
      resolveWorktreeCwd('', wt, root, p) === ''
    )
    check(
      `resolveWorktreeCwd (${label}): no worktree -> the project folder`,
      resolveWorktreeCwd(root, null, root, p) === root
    )
    check(
      `resolveWorktreeCwd (${label}): project IS the repo root -> the worktree`,
      resolveWorktreeCwd(root, wt, root, p) === wt
    )
    check(
      `resolveWorktreeCwd (${label}): project is a SUBFOLDER -> same subpath inside`,
      resolveWorktreeCwd(`${root}${sep}apps${sep}web`, wt, root, p) === `${wt}${sep}apps${sep}web`
    )
    check(
      `resolveWorktreeCwd (${label}): no repo root -> the project folder`,
      resolveWorktreeCwd(`${root}${sep}apps${sep}web`, wt, null, p) === `${root}${sep}apps${sep}web`
    )
    check(
      `resolveWorktreeCwd (${label}): workspace outside the repo -> the project folder`,
      resolveWorktreeCwd(
        label === 'win32' ? 'C:\\elsewhere\\app' : '/elsewhere/app',
        wt,
        root,
        p
      ) === (label === 'win32' ? 'C:\\elsewhere\\app' : '/elsewhere/app')
    )
  }
  // A worktree must never silently drop a deep subpath.
  check(
    'resolveWorktreeCwd keeps a nested subpath intact',
    resolveWorktreeCwd('/repo/packages/ui/src', '/wt/fix', '/repo', posixPath) ===
      '/wt/fix/packages/ui/src'
  )
  // ---- usage / cost math ----
  check(
    'cost: emptyUsage is all zeros, not estimated',
    totalTokens(emptyUsage()) === 0 && emptyUsage().estimated === false
  )
  const uA: TokenUsage = {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 0,
    reasoning: 5,
    estimated: false
  }
  const uB: TokenUsage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    reasoning: 0,
    estimated: true
  }
  const summed = addUsage(uA, uB)
  check(
    'cost: addUsage sums fields',
    summed.input === 101 && summed.output === 52 && summed.cacheWrite === 4
  )
  check('cost: addUsage estimated is sticky', summed.estimated === true)
  check('cost: totalTokens counts input+output+cache', totalTokens(uA) === 160)
  // Pricing: $3/1M input, $15/1M output, $0.30/1M cache read.
  const price = { input: 3, output: 15, cacheRead: 0.3 }
  // 100/1e6*3 + 50/1e6*15 + 10/1e6*0.3 = 0.0003 + 0.00075 + 0.000003 = 0.001053
  const c = usageCost(uA, price)
  check('cost: usageCost prices input/output/cache', Math.abs(c - 0.001053) < 1e-9)
  check('cost: usageCost is 0 with no price', usageCost(uA, undefined) === 0)
  check(
    'cost: cacheRead falls back to input rate',
    usageCost(
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0, reasoning: 0, estimated: false },
      { input: 2 }
    ) === 2
  )
  check(
    'cost: isPriced true when any rate set',
    isPriced({ output: 1 }) && !isPriced({}) && !isPriced(undefined)
  )
  check('cost: localDay formats YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(localDay(Date.now())))

  // Aggregation over a fixed set of records.
  const now = new Date('2026-02-15T12:00:00').getTime()
  const todayStart = new Date('2026-02-15T00:00:00').getTime()
  const DAY = 24 * 60 * 60 * 1000
  const rec = (over: Partial<UsageRecord>): UsageRecord => ({
    id: Math.random().toString(36).slice(2),
    chatId: 'c1',
    providerId: 'openai',
    model: 'gpt-x',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    estimated: false,
    createdAt: now,
    ...over
  })
  const records: UsageRecord[] = [
    rec({
      providerId: 'openai',
      model: 'gpt-x',
      input: 1000,
      output: 500,
      cost: 0.02,
      createdAt: now
    }),
    rec({
      providerId: 'openai',
      model: 'gpt-x',
      input: 200,
      output: 100,
      cost: 0.005,
      createdAt: now - 3 * DAY
    }),
    rec({
      providerId: 'anthropic',
      model: 'claude-y',
      input: 4000,
      output: 2000,
      cost: 0.1,
      estimated: true,
      createdAt: now - 1 * DAY
    }),
    rec({
      providerId: 'google',
      model: 'gemini-z',
      input: 100,
      output: 50,
      cost: 0,
      createdAt: now
    }) // unpriced
  ]
  const stats = aggregateUsage(
    records,
    { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Gemini' },
    now,
    todayStart
  )
  check('agg: overview 30d cost sums all', Math.abs(stats.overview.last30d.cost - 0.125) < 1e-9)
  check(
    'agg: overview 30d tokens sum all',
    stats.overview.last30d.tokens === 1500 + 300 + 6000 + 150
  )
  check(
    'agg: today only counts todayStart+',
    stats.overview.today.tokens === 1500 + 150 && Math.abs(stats.overview.today.cost - 0.02) < 1e-9
  )
  check('agg: top model by token volume', stats.overview.topModel === 'claude-y')
  check('agg: daily has 30 entries', stats.overview.daily.length === 30)
  check(
    'agg: last daily entry is today',
    stats.overview.daily[29].date === localDay(now) &&
      stats.overview.daily[29].tokens === 1500 + 150
  )
  check('agg: overview flags estimates', stats.overview.hasEstimates === true)
  check('agg: overview flags unpriced', stats.overview.hasUnpriced === true)
  check('agg: one tab per provider', stats.providers.length === 3)
  check('agg: providers sorted by 30d cost desc', stats.providers[0].providerId === 'anthropic')
  check('agg: provider name resolved', stats.providers[0].name === 'Anthropic')
  const openaiTab = stats.providers.find((p) => p.providerId === 'openai')
  check(
    'agg: provider tab isolates its records',
    openaiTab?.last30d.calls === 2 && openaiTab?.last30d.tokens === 1800
  )
  check(
    'agg: empty records → empty overview',
    aggregateUsage([], {}, now, todayStart).overview.last30d.tokens === 0
  )

  // ---- activity (contribution graph) ----------------------------------------
  const aNow = new Date(2026, 0, 15, 12, 0, 0).getTime() // fixed local noon
  const DAYMS = 24 * 60 * 60 * 1000
  check('activity: level 0 for no turns', activityLevel(0, 10) === 0)
  check('activity: level 0 when peak is 0', activityLevel(3, 0) === 0)
  check('activity: single turn is at least level 1', activityLevel(1, 100) === 1)
  check('activity: peak day is level 4', activityLevel(100, 100) === 4)
  check('activity: just over half → level 3', activityLevel(60, 100) === 3)
  check('activity: exactly half → level 2', activityLevel(50, 100) === 2)
  check('activity: a quarter → level 1', activityLevel(25, 100) === 1)

  // Three turns today, two yesterday, one three days ago (all local-day bucketed).
  const turns = [
    aNow,
    aNow - 60_000,
    aNow - 120_000,
    aNow - DAYMS,
    aNow - DAYMS - 60_000,
    aNow - 3 * DAYMS
  ]
  const act = aggregateActivity(turns, aNow, 182)
  check('activity: series length matches window', act.days.length === 182)
  check('activity: total counts every turn', act.total === 6)
  check('activity: busiest day is 3 turns', act.max === 3)
  check('activity: three distinct active days', act.activeDays === 3)
  check('activity: last cell is today', act.days[181].date === localDay(aNow))
  check(
    'activity: today counts 3 turns at level 4',
    act.days[181].count === 3 && act.days[181].level === 4
  )
  check('activity: yesterday counts 2 turns', act.days[180].count === 2)
  check('activity: current streak spans today+yesterday', act.currentStreak === 2)
  check('activity: longest streak is 2', act.longestStreak === 2)
  check('activity: empty input → zeroed stats', aggregateActivity([], aNow, 182).total === 0)
  check(
    'activity: idle today → current streak 0',
    aggregateActivity([aNow - 5 * DAYMS], aNow, 182).currentStreak === 0
  )

  // ---- forge: remote URL parsing ------------------------------------------
  // Every shape below was taken from a real clone URL the vendors hand out.
  // These are the highest-risk lines in the feature: a mis-parse means requests
  // fired at the wrong host or a silent 404, with no obvious cause in the UI.

  check(
    'forge: scp-like github',
    (() => {
      const r = parseRemote('git@github.com:FreddyJD/roxy.git')
      return r?.kind === 'github' && r.owner === 'FreddyJD' && r.repo === 'roxy'
    })()
  )
  check(
    'forge: https github + .git',
    (() => {
      const r = parseRemote('https://github.com/FreddyJD/roxy.git')
      return r?.slug === 'FreddyJD/roxy' && r.apiBase === 'https://api.github.com'
    })()
  )
  check(
    'forge: github enterprise uses /api/v3',
    (() => {
      const r = parseRemote('https://github.acme.com/team/app.git')
      return (
        r?.kind === 'github' && r.cloud === false && r.apiBase === 'https://github.acme.com/api/v3'
      )
    })()
  )
  check(
    'forge: ssh:// github with port',
    (() => {
      const r = parseRemote('ssh://git@github.com:22/FreddyJD/roxy.git')
      return r?.kind === 'github' && r.owner === 'FreddyJD' && r.repo === 'roxy'
    })()
  )

  check(
    'forge: ADO dev.azure.com org/project/_git/repo',
    (() => {
      const r = parseRemote('https://dev.azure.com/msft/Edge/_git/browser')
      return (
        r?.kind === 'azure-devops' &&
        r.owner === 'msft' &&
        r.project === 'Edge' &&
        r.repo === 'browser'
      )
    })()
  )
  check(
    'forge: ADO with org in userinfo',
    (() => {
      const r = parseRemote('https://msft@dev.azure.com/msft/Edge/_git/browser')
      return r?.owner === 'msft' && r.project === 'Edge' && r.repo === 'browser'
    })()
  )
  check(
    'forge: ADO shorthand /_git/repo implies project==repo',
    (() => {
      const r = parseRemote('https://dev.azure.com/msft/_git/browser')
      return r?.owner === 'msft' && r.project === 'browser' && r.repo === 'browser'
    })()
  )
  check(
    'forge: ADO ssh v3 form',
    (() => {
      const r = parseRemote('git@ssh.dev.azure.com:v3/msft/Edge/browser')
      return (
        r?.kind === 'azure-devops' &&
        r.owner === 'msft' &&
        r.project === 'Edge' &&
        r.repo === 'browser'
      )
    })()
  )
  check(
    'forge: ADO legacy visualstudio.com',
    (() => {
      const r = parseRemote('https://msft.visualstudio.com/Edge/_git/browser')
      return (
        r?.kind === 'azure-devops' &&
        r.owner === 'msft' &&
        r.project === 'Edge' &&
        r.repo === 'browser'
      )
    })()
  )
  check(
    'forge: ADO legacy DefaultCollection is skipped',
    (() => {
      const r = parseRemote('https://msft.visualstudio.com/DefaultCollection/Edge/_git/browser')
      return r?.project === 'Edge' && r.repo === 'browser'
    })()
  )
  check(
    'forge: ADO project with a space survives',
    (() => {
      const r = parseRemote('https://dev.azure.com/msft/My%20Project/_git/app')
      return r?.project === 'My%20Project' && r.repo === 'app'
    })()
  )

  check(
    'forge: gitlab nested groups keep full namespace',
    (() => {
      const r = parseRemote('https://gitlab.com/group/subgroup/app.git')
      return r?.kind === 'gitlab' && r.owner === 'group/subgroup' && r.repo === 'app'
    })()
  )
  check(
    'forge: gitlab self-hosted api/v4',
    (() => {
      const r = parseRemote('git@gitlab.acme.com:team/app.git')
      return (
        r?.kind === 'gitlab' && r.apiBase === 'https://gitlab.acme.com/api/v4' && r.cloud === false
      )
    })()
  )

  check(
    'forge: bitbucket cloud',
    (() => {
      const r = parseRemote('https://bitbucket.org/acme/app.git')
      return (
        r?.kind === 'bitbucket' && r.cloud === true && r.apiBase === 'https://api.bitbucket.org/2.0'
      )
    })()
  )
  check(
    'forge: bitbucket server /scm/ prefix stripped',
    (() => {
      const r = parseRemote('https://bitbucket.acme.com/scm/PROJ/app.git')
      return r?.kind === 'bitbucket' && r.cloud === false && r.owner === 'PROJ' && r.repo === 'app'
    })()
  )

  check('forge: local path is not a forge', parseRemote('/home/me/repo.git') === null)
  check('forge: file:// is not a forge', parseRemote('file:///srv/repo.git') === null)
  check('forge: unknown host is not guessed', parseRemote('git@example.com:me/app.git') === null)
  check('forge: empty string is safe', parseRemote('') === null)
  check('forge: junk is safe', parseRemote('not a url at all') === null)

  check(
    'forge: splitRemoteUrl scp colon is not a port',
    (() => {
      const s = splitRemoteUrl('git@github.com:FreddyJD/roxy.git')
      return s?.host === 'github.com' && s.path === 'FreddyJD/roxy'
    })()
  )
  check('forge: host detection is case-insensitive', forgeKindForHost('GitHub.COM') === 'github')
  check('forge: every kind has a display name', Object.keys(FORGE_NAMES).length === 4)

  // ---- forge: branch lifecycle --------------------------------------------
  const noSync = { ahead: 0, behind: 0, hasUpstream: false, dirty: false }
  const mkPr = (over: Partial<PullRequestView>): PullRequestView => ({
    number: 42,
    title: 't',
    state: 'open',
    url: 'u',
    sourceBranch: 's',
    targetBranch: 'main',
    author: 'a',
    createdAt: 0,
    updatedAt: 0,
    checks: null,
    review: null,
    ...over
  })

  check(
    'lifecycle: no upstream is local',
    (() => {
      const v = branchLifecycle({ sync: noSync, pr: null, forgeKnown: false })
      return v.phase === 'unpublished' && v.label === 'local' && v.action === 'push'
    })()
  )
  check(
    'lifecycle: ahead shows the count',
    (() => {
      const v = branchLifecycle({
        sync: { ...noSync, hasUpstream: true, ahead: 3 },
        pr: null,
        forgeKnown: true
      })
      return v.phase === 'ahead' && v.label === '\u21913' && v.action === 'push'
    })()
  )
  check(
    'lifecycle: behind suggests a pull',
    (() => {
      const v = branchLifecycle({
        sync: { ...noSync, hasUpstream: true, behind: 2 },
        pr: null,
        forgeKnown: true
      })
      return v.phase === 'behind' && v.action === 'pull' && v.tone === 'warning'
    })()
  )
  check(
    'lifecycle: synced + forge known offers a PR',
    (() => {
      const v = branchLifecycle({
        sync: { ...noSync, hasUpstream: true },
        pr: null,
        forgeKnown: true
      })
      return v.phase === 'synced' && v.action === 'open-pr'
    })()
  )
  check(
    'lifecycle: synced + forge UNKNOWN offers nothing',
    (() => {
      const v = branchLifecycle({
        sync: { ...noSync, hasUpstream: true },
        pr: null,
        forgeKnown: false
      })
      return v.phase === 'synced' && v.action === null
    })()
  )
  check(
    'lifecycle: open PR shows its number',
    (() => {
      const v = branchLifecycle({
        sync: { ...noSync, hasUpstream: true },
        pr: mkPr({}),
        forgeKnown: true
      })
      return v.phase === 'open' && v.label === '#42' && v.action === 'view-pr'
    })()
  )
  check(
    'lifecycle: failing checks turn the chip danger',
    (() => {
      const v = branchLifecycle({
        sync: { ...noSync, hasUpstream: true },
        pr: mkPr({ checks: 'failing' }),
        forgeKnown: true
      })
      return v.tone === 'danger'
    })()
  )
  check(
    'lifecycle: changes requested is a warning',
    (() => {
      const v = branchLifecycle({
        sync: { ...noSync, hasUpstream: true },
        pr: mkPr({ review: 'changes_requested' }),
        forgeKnown: true
      })
      return v.tone === 'warning'
    })()
  )
  check(
    'lifecycle: draft reads as draft',
    (() => {
      const v = branchLifecycle({
        sync: { ...noSync, hasUpstream: true },
        pr: mkPr({ state: 'draft' }),
        forgeKnown: true
      })
      return v.phase === 'draft' && v.label === '#42 draft'
    })()
  )
  // The important one: a merged PR is the truth even when the local branch
  // still looks unpushed. Showing "local" on merged work is the bug this guards.
  check(
    'lifecycle: merged PR outranks stale local state',
    (() => {
      const v = branchLifecycle({
        sync: { ...noSync, ahead: 9 },
        pr: mkPr({ state: 'merged' }),
        forgeKnown: true
      })
      return v.phase === 'merged' && v.label === 'merged' && v.tone === 'success'
    })()
  )
  check(
    'lifecycle: closed PR outranks ahead count',
    (() => {
      const v = branchLifecycle({
        sync: { ...noSync, hasUpstream: true, ahead: 4 },
        pr: mkPr({ state: 'closed' }),
        forgeKnown: true
      })
      return v.phase === 'closed'
    })()
  )

  // ---- forge: unknown hosts + user override -------------------------------
  // The separation that matters: a LOCAL path is "no host, show nothing", while
  // an unrecognised DOMAIN is "a real server, ask the user once". Collapsing
  // them would break self-hosted GitLab/Bitbucket behind a corporate domain -
  // the most common case in exactly the enterprises this is for.

  check('detect: local path has no host at all', detectHost('/home/me/repo.git') === null)
  check(
    'detect: bare host with no repo path is unusable',
    detectHost('https://git.mycorp.com') === null
  )
  check(
    'detect: known host resolves without asking',
    (() => {
      const p = detectHost('https://github.com/a/b.git')
      return p?.host === 'github.com' && p.kind === 'github'
    })()
  )
  check(
    'detect: unknown domain is a real host awaiting an answer',
    (() => {
      const p = detectHost('https://git.mycorp.com/team/app.git')
      return p?.host === 'git.mycorp.com' && p.kind === null
    })()
  )
  check(
    'detect: scp-like unknown host still probes',
    (() => {
      const p = detectHost('git@git.mycorp.com:team/app.git')
      return p?.host === 'git.mycorp.com' && p.kind === null
    })()
  )

  check(
    'override: applies to an unrecognised host',
    (() => {
      const r = parseRemote('https://git.mycorp.com/team/app.git', 'gitlab')
      return (
        r?.kind === 'gitlab' &&
        r.owner === 'team' &&
        r.repo === 'app' &&
        r.apiBase === 'https://git.mycorp.com/api/v4'
      )
    })()
  )
  check(
    'override: unknown host without one stays unresolved',
    (() => {
      return parseRemote('https://git.mycorp.com/team/app.git') === null
    })()
  )
  // The safety property: a saved override must never hijack a host we can
  // identify, or one bad guess would silently mis-route github.com forever.
  check(
    'override: never overrides a KNOWN host',
    (() => {
      const r = parseRemote('https://github.com/a/b.git', 'gitlab')
      return r?.kind === 'github'
    })()
  )
  check(
    'override: null behaves as absent',
    (() => {
      return parseRemote('https://git.mycorp.com/team/app.git', null) === null
    })()
  )
  check(
    'override: cannot rescue a non-host',
    (() => {
      return parseRemote('/home/me/repo.git', 'github') === null
    })()
  )
  check(
    'override: azure-devops shape still parses under override',
    (() => {
      const r = parseRemote(
        'https://tfs.mycorp.com/DefaultCollection/Proj/_git/app',
        'azure-devops'
      )
      return r?.kind === 'azure-devops' && r.project === 'Proj' && r.repo === 'app'
    })()
  )
  const NOW = 1_700_000_000_000
  check('relativeAge: seconds', relativeAge(NOW - 5_000, NOW) === 'just now')
  check('relativeAge: minutes', relativeAge(NOW - 5 * 60_000, NOW) === '5m ago')
  check('relativeAge: hours', relativeAge(NOW - 3 * 3_600_000, NOW) === '3h ago')
  check('relativeAge: days', relativeAge(NOW - 4 * 86_400_000, NOW) === '4d ago')
  check('relativeAge: future clamps to now', relativeAge(NOW + 10_000, NOW) === 'just now')
  // ---- per-session inference config (model/mode/effort/context) ----
  //
  // Two rules carry the whole feature, so both are pinned here:
  //   1. a session that pinned a value keeps it, whatever the globals say
  //   2. a session that pinned nothing follows the globals (the last-used
  //      template), which is what every pre-upgrade session does.
  const gSettings = {
    onboardingCompleted: true,
    activeProviderId: 'anthropic',
    activeModel: 'claude-opus-5',
    activeAgentId: 'plan',
    reasoningEffort: 'max' as const,
    contextLimit: 1_000_000,
    webSearchApiKey: null
  }
  const bare = {
    providerId: null,
    model: null,
    agentId: null,
    reasoningEffort: null,
    contextLimit: null
  }

  const inherited = resolveSessionConfig(bare, gSettings)
  check(
    'session config: an unpinned session inherits the global model',
    inherited.providerId === 'anthropic' && inherited.model === 'claude-opus-5'
  )
  check(
    'session config: an unpinned session inherits effort + context',
    inherited.reasoningEffort === 'max' && inherited.contextLimit === 1_000_000
  )
  check(
    'session config: mode falls back to the default agent, not the global',
    resolveSessionConfig(bare, gSettings).agentId === DEFAULT_AGENT_ID
  )

  const pinned = resolveSessionConfig(
    {
      ...bare,
      providerId: 'openai',
      model: 'gpt-5',
      agentId: 'build',
      reasoningEffort: 'low' as const,
      contextLimit: 64_000
    },
    gSettings
  )
  check(
    'session config: a pinned session ignores the global model',
    pinned.providerId === 'openai' && pinned.model === 'gpt-5'
  )
  check(
    'session config: a pinned session ignores global effort + context',
    pinned.reasoningEffort === 'low' && pinned.contextLimit === 64_000
  )
  check('session config: a pinned session keeps its own mode', pinned.agentId === 'build')

  // provider + model are ONE decision: a session pinned to a provider must not
  // borrow another provider's model id, which would 404 the turn.
  const halfPinned = resolveSessionConfig({ ...bare, providerId: 'openai' }, gSettings)
  check(
    "session config: pinning a provider does not inherit the other provider's model",
    halfPinned.providerId === 'openai' && halfPinned.model === null
  )

  // No settings at all (fresh install, before onboarding).
  const empty = resolveSessionConfig(null, null)
  check(
    'session config: resolves with no chat and no settings',
    empty.providerId === null &&
      empty.model === null &&
      empty.agentId === DEFAULT_AGENT_ID &&
      empty.reasoningEffort === 'high' &&
      empty.contextLimit === null
  )

  // The seed is what a NEW session is stamped with - the "next session
  // remembers what I last picked" half of the feature. Unlike the resolver, it
  // DOES take the global mode.
  const seeded = seedSessionConfig(gSettings)
  check(
    'session seed: a new session inherits the last-used model + mode',
    seeded.providerId === 'anthropic' &&
      seeded.model === 'claude-opus-5' &&
      seeded.agentId === 'plan'
  )
  check(
    'session seed: a new session inherits the last-used effort + context',
    seeded.reasoningEffort === 'max' && seeded.contextLimit === 1_000_000
  )
  check(
    'session seed: no settings yields the plain defaults',
    seedSessionConfig(null).agentId === DEFAULT_AGENT_ID &&
      seedSessionConfig(null).reasoningEffort === 'high'
  )

  // parseReasoningEffort guards the DB column + IPC payloads.
  check(
    'session config: parseReasoningEffort accepts the ladder',
    parseReasoningEffort('low') === 'low' &&
      parseReasoningEffort('xhigh') === 'xhigh' &&
      parseReasoningEffort('max') === 'max'
  )
  check(
    'session config: parseReasoningEffort rejects junk',
    parseReasoningEffort('turbo') === null &&
      parseReasoningEffort(null) === null &&
      parseReasoningEffort(7) === null
  )

  // Claude reports a 200K base but really exposes 1M - the picker's ceiling.
  check(
    'context max: a large reasoning model is raised to 1M',
    effectiveContextMax({ reasoning: true, contextLimit: 200_000 }) === 1_000_000
  )
  check(
    'context max: a non-reasoning model keeps its real window',
    effectiveContextMax({ reasoning: false, contextLimit: 200_000 }) === 200_000
  )
  check(
    'context max: a small model is left alone',
    effectiveContextMax({ reasoning: true, contextLimit: 128_000 }) === 128_000
  )
  check(
    'context budget: defaults to 200K, capped by the model window',
    contextBudgetFor(null, 1_000_000) === 200_000 && contextBudgetFor(null, 128_000) === 128_000
  )
  check(
    'context budget: a chosen limit never exceeds the model window',
    contextBudgetFor(1_000_000, 128_000) === 128_000 &&
      contextBudgetFor(400_000, 1_000_000) === 400_000
  )

  // ---- attachment hover-preview geometry (renderer/lib/anchor) ----------------
  // A thumbnail's floating preview must never leave the viewport and never cover
  // the thumbnail that opened it, at any window size or aspect ratio.
  const thumb = (left: number, top: number, size = 36): Rect => ({
    left,
    top,
    right: left + size,
    bottom: top + size,
    width: size,
    height: size
  })
  const boxOf = (p: NonNullable<ReturnType<typeof place>>) => ({
    left: p.left,
    top: p.top,
    right: p.left + p.width,
    bottom: p.top + p.height + CHROME_H
  })
  const disjoint = (a: ReturnType<typeof boxOf>, t: Rect): boolean =>
    a.right <= t.left || a.left >= t.right || a.bottom <= t.top || a.top >= t.bottom

  // Sweep a thumbnail across a grid of positions, viewports, and image shapes.
  const shapes: Array<[number, number, string]> = [
    [1568, 720, 'wide'],
    [600, 1400, 'tall'],
    [900, 900, 'square'],
    [64, 64, 'tiny'],
    [3000, 80, 'panorama'],
    [80, 3000, 'strip']
  ]
  const viewports: Array<[number, number]> = [
    [1280, 780],
    [1920, 1080],
    [900, 600],
    [700, 420],
    [420, 300]
  ]
  let escapes = 0
  let overlaps = 0
  let oversize = 0
  let placements = 0
  let nulls = 0
  for (const [vw, vh] of viewports) {
    for (let fx = 0.02; fx < 1; fx += 0.16) {
      for (let fy = 0.02; fy < 1; fy += 0.16) {
        const t = thumb(Math.round(fx * (vw - 36)), Math.round(fy * (vh - 36)))
        for (const [iw, ih] of shapes) {
          const p = place(t, iw, ih, vw, vh)
          if (!p) {
            nulls++
            continue
          }
          placements++
          const b = boxOf(p)
          if (b.left < MARGIN || b.top < MARGIN || b.right > vw - MARGIN || b.bottom > vh - MARGIN)
            escapes++
          if (!disjoint(b, t)) overlaps++
          if (p.width > MAX_W || p.height > MAX_H) oversize++
        }
      }
    }
  }
  check(`anchor: ${placements} placements produced (grid is non-trivial)`, placements > 400)
  check('anchor: never escapes the viewport margins', escapes === 0, `${escapes} escaped`)
  check('anchor: never covers its own trigger', overlaps === 0, `${overlaps} overlapped`)
  check('anchor: respects the size ceilings', oversize === 0, `${oversize} oversized`)

  // Aspect ratio must survive the fit, or screenshots read as distorted.
  const ratioOk = shapes.every(([iw, ih]) => {
    const p = place(thumb(600, 400), iw, ih, 1280, 780)
    if (!p) return true
    return Math.abs(p.width / p.height - iw / ih) < 0.04 * (iw / ih)
  })
  check('anchor: preserves aspect ratio', ratioOk)

  // Above is the natural direction when there is room for it.
  const roomy = place(thumb(600, 700), 900, 400, 1280, 900)
  check('anchor: prefers above when it fits', roomy?.side === 'top', String(roomy?.side))

  // A thumbnail pinned to the top has to flip below.
  const atTop = place(thumb(600, 4), 900, 400, 1280, 900)
  check('anchor: flips below near the top edge', atTop?.side === 'bottom', String(atTop?.side))

  // A tall image beside a mid-height thumbnail fits in neither band -> sideways.
  const tallMid = place(thumb(600, 380), 600, 1400, 1280, 780)
  check(
    'anchor: goes sideways when neither band fits',
    tallMid !== null && (tallMid.side === 'left' || tallMid.side === 'right'),
    String(tallMid?.side)
  )

  // Small images are enlarged to a legible size, not shown at 64px.
  const upscaled = place(thumb(600, 700), 64, 64, 1280, 900)
  check('anchor: upscales tiny images', (upscaled?.width ?? 0) >= 200, String(upscaled?.width))

  // ...but never past the space actually available.
  const tightUp = place(thumb(300, 150, 20), 64, 64, 360, 300)
  check(
    'anchor: upscaling still respects the viewport',
    tightUp === null || boxOf(tightUp).right <= 360 - MARGIN,
    JSON.stringify(tightUp)
  )

  // Degenerate inputs must not produce NaN coordinates or a box at all.
  check('anchor: rejects zero-sized images', place(thumb(100, 100), 0, 0, 1280, 800) === null)
  check('anchor: gives up in a tiny viewport', place(thumb(20, 20), 900, 900, 120, 100) === null)

  // Every preview it does produce must be a real step up from the thumbnail --
  // otherwise it covers the UI to show you what you could already see.
  let puny = 0
  for (const [vw, vh] of viewports) {
    for (let fx = 0.02; fx < 1; fx += 0.16) {
      for (let fy = 0.02; fy < 1; fy += 0.16) {
        for (const size of [36, 48, 64, 192]) {
          const t = thumb(Math.round(fx * (vw - size)), Math.round(fy * (vh - size)), size)
          for (const [iw, ih] of shapes) {
            const p = place(t, iw, ih, vw, vh)
            if (p && Math.max(p.width, p.height) < size * 1.5) puny++
          }
        }
      }
    }
  }
  check('anchor: never opens a preview barely bigger than its thumbnail', puny === 0, `${puny}`)

  // The gap is real: the box shouldn't touch the thumbnail.
  const gapped = place(thumb(600, 700), 900, 400, 1280, 900)
  check(
    'anchor: leaves a gap above the trigger',
    gapped !== null && Math.round(700 - boxOf(gapped).bottom) === GAP,
    gapped ? String(700 - boxOf(gapped).bottom) : 'null'
  )
  if (fails.length) {
    console.error(`\nSHARED FAILED \u2014 ${fails.length} failing: ${fails.join(', ')}`)
    process.exit(1)
  }
  console.log(`\nSHARED OK \u2014 ${pass} checks passed`)
}
void main()
