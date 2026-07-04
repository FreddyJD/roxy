/**
 * Minimal mock MCP server for the Phase 13 smoke test. Speaks the real
 * newline-delimited JSON-RPC-over-stdio MCP wire protocol so it exercises the
 * ACTUAL @modelcontextprotocol/sdk Client machinery — initialize handshake,
 * capability negotiation, tools/list, tools/call — without needing an external
 * MCP server installed.
 *
 * Tools:
 *   - echo: returns a text result echoing its `message` argument.
 *   - boom: returns an `isError` result (to prove error rendering + ok:false).
 *
 * Run as: <node|electron-as-node> mock-mcp.cjs
 */
'use strict'

let buf = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) break
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg)
  }
})

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided message.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Text to echo' } },
      required: ['message']
    }
  },
  {
    name: 'boom',
    description: 'Always fails (for error-path testing).',
    inputSchema: { type: 'object', properties: {} }
  }
]

function handle(msg) {
  // Notifications (no id) — nothing to reply to.
  if (msg.id === undefined || msg.id === null) return

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          // Echo the client's requested version (already one it supports).
          protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '0.0.1' }
        }
      })
      return
    case 'ping':
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
      return
    case 'tools/call': {
      const name = msg.params && msg.params.name
      const args = (msg.params && msg.params.arguments) || {}
      if (name === 'echo') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'echo: ' + String(args.message ?? '') }] }
        })
        return
      }
      if (name === 'boom') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'boom: intentional failure' }], isError: true }
        })
        return
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: 'Unknown tool: ' + String(name) }
      })
      return
    }
    default:
      // Unknown request → method-not-found (keeps the client from hanging).
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
  }
}
