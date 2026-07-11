/**
 * Pure-Node validation of the shared catalogs (no Electron, no DB).
 * Run: npm run smoke:shared
 */
import { TOOLS, getTool, resolveToolIds, TOOL_CATEGORIES } from '../src/shared/tools'
import { AGENTS, getAgent, PRIMARY_AGENTS, SUBAGENTS, DEFAULT_AGENT_ID } from '../src/shared/agents'
import { SEED_PROVIDERS, resolveSeed, isConnectableNow } from '../src/shared/providers'
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
import type { Message, MessagePart } from '../src/shared/types'
import type { ChatMessage } from '../src/shared/api'
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

  // window.roxy.remote.* must match the RoxyApi type surface exactly.
  check('preload exposes remote.start', /\bstart:/.test(preloadRemote))
  check('preload exposes remote.stop', /\bstop:/.test(preloadRemote))
  check('preload exposes remote.status', /\bstatus:/.test(preloadRemote))
  check('preload exposes remote.onState', /\bonState:/.test(preloadRemote))
  check('api declares remote.start', /\bstart\(/.test(apiRemote))
  check('api declares remote.stop', /\bstop\(/.test(apiRemote))
  check('api declares remote.status', /\bstatus\(/.test(apiRemote))
  check('api declares remote.onState', /\bonState\(/.test(apiRemote))
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
  check('portable: summarizeBundle reads naturally', summarizeBundle(goodBundle) === '1 skill, 2 MCP servers')

  const roundTrip = parseBundle(serializeBundle(goodBundle))
  check('portable: serialize -> parse round-trips', roundTrip.ok === true)
  if (roundTrip.ok) {
    check('portable: round-trip preserves the skill file', roundTrip.bundle.skills[0].files.length === 2)
    check(
      'portable: round-trip preserves a disabled server',
      roundTrip.bundle.mcpServers.find((s) => s.id === 'remote1')?.enabled === false
    )
  }

  // Rejections
  check('portable: parse rejects non-JSON', parseBundle('not json').ok === false)
  check('portable: parse rejects the wrong kind', parseBundle('{"kind":"nope","version":1}').ok === false)
  check(
    'portable: parse rejects a future version',
    parseBundle(JSON.stringify({ kind: BUNDLE_KIND, version: 999, skills: [], mcpServers: [] })).ok === false
  )
  check(
    'portable: parse rejects an empty bundle',
    parseBundle(JSON.stringify({ kind: BUNDLE_KIND, version: 1, skills: [], mcpServers: [] })).ok === false
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
  check('portable: parse drops a skill missing SKILL.md', dirty.ok === true && dirty.bundle.skills.length === 1)
  check(
    'portable: parse strips unsafe companion paths (keeps only SKILL.md)',
    dirty.ok === true &&
      dirty.bundle.skills[0].files.length === 1 &&
      dirty.bundle.skills[0].files[0].path === 'SKILL.md'
  )
  check(
    'portable: parse keeps only the valid MCP server',
    dirty.ok === true && dirty.bundle.mcpServers.length === 1 && dirty.bundle.mcpServers[0].id === 'good'
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
  if (fails.length) {
    console.error(`\nSHARED FAILED \u2014 ${fails.length} failing: ${fails.join(', ')}`)
    process.exit(1)
  }
  console.log(`\nSHARED OK \u2014 ${pass} checks passed`)
}
void main()
