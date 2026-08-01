/**
 * Regression guard: a store action shaped `(chatId?: string) => …` must survive
 * being handed a React SyntheticEvent.
 *
 * `onStop={stop}` compiled clean — TypeScript lets `(id?: string) => void` be
 * assigned to `() => void` — and React then called it with the click event,
 * which became the "session" to stop. That keyed state as "[object Object]",
 * matched no in-flight request, and threw "An object could not be cloned" when
 * it hit the IPC boundary, so the turn was never aborted and Stop looked stuck.
 *
 * Run: node test/store-guard.mjs
 */
import { globSync, readFileSync } from 'node:fs'

// Normalize CRLF up front: this repo checks out with Windows line endings and
// every multiline pattern below would otherwise silently never match.
const src = readFileSync(
  new URL('../src/renderer/src/lib/store.ts', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  \u2713 ${name}`)
  } else {
    failures++
    console.log(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

console.log('store: event-as-argument guards')

// 1. The guard exists and rejects non-strings.
check(
  'asChatId helper is present in the store',
  /const asChatId = \(value: unknown\): string \| undefined =>/.test(src)
)

const asChatId = (value) => (typeof value === 'string' ? value : undefined)
const fakeClickEvent = { nativeEvent: {}, target: {}, currentTarget: {}, type: 'click' }
check('a SyntheticEvent is rejected', asChatId(fakeClickEvent) === undefined)
check('a real chat id passes through', asChatId('chat_123') === 'chat_123')
check('undefined stays undefined', asChatId(undefined) === undefined)

// 2. Both at-risk actions route their argument through the guard. These are the
//    only two store actions with an optional FIRST parameter — i.e. the only two
//    a bare handler can poison. Match the IMPLEMENTATION (`name: (arg) => {` or
//    `name: async (arg) => {`), not the interface declaration above it.
for (const action of ['stop', 'compactConversation']) {
  const impl = new RegExp(
    `^  ${action}: (?:async )?\\([^)]*\\) => \\{\\n([\\s\\S]*?)\\n  \\},`,
    'm'
  )
  const body = src.match(impl)?.[1]
  check(`${action}: implementation found`, body !== undefined)
  check(
    `${action} funnels its argument through asChatId`,
    body !== undefined && body.includes('asChatId('),
    'an unguarded optional-id action can swallow a click event'
  )
}

// 3. No .tsx passes either action bare into a handler prop. This is the actual
//    call-site bug; the runtime guard is the safety net behind it.
//
//    The real bug lived in a TERNARY BRANCH (`onStop={cond ? () => … : stop}`),
//    so matching only `on…={stop}` missed it entirely — the first version of
//    this test passed against the unfixed code. Instead: capture the whole
//    handler expression, then look for the action name used as a BARE reference
//    (not `stop(`, not `.stop`, not `stopChats`) anywhere inside it.
const RISKY = ['stop', 'compactConversation']
const offenders = []
for (const file of globSync('src/renderer/src/**/*.tsx')) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  // Handler prop up to its balancing brace, tolerating newlines and one level
  // of nested braces (enough for the arrow bodies these expressions contain).
  for (const m of text.matchAll(/\bon[A-Z]\w*=\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    const expr = m[1]
    for (const name of RISKY) {
      // Bare use: the identifier NOT followed by `(` and NOT preceded by `.`
      // or a word character. `() => stop()` is a call — safe. `: stop` is not.
      const bare = new RegExp(`(?<![.\\w])${name}(?!\\s*\\()(?![\\w])`)
      if (bare.test(expr)) {
        offenders.push(`${file}: on…={…${name}…}`)
      }
    }
  }
}
check(
  'no component passes stop/compactConversation bare to a handler',
  offenders.length === 0,
  offenders.join(', ')
)

console.log(failures === 0 ? '\nSTORE GUARD OK' : `\nSTORE GUARD FAILED \u2014 ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
