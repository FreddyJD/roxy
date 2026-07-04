/**
 * Minimal mock language server for the Phase 12 LSP smoke test. Speaks the real
 * JSON-RPC-over-stdio LSP wire protocol (Content-Length framing) so it exercises
 * the actual LspClient machinery — handshake, didOpen/didChange, publishDiagnostics
 * — without needing a real language server installed.
 *
 * Behavior: it publishes one ERROR diagnostic for any document whose text
 * contains the token "BROKEN", and an empty (clean) diagnostic set otherwise.
 * Run as: <node|electron-as-node> mock-lsp.cjs
 */
'use strict'

let buf = Buffer.alloc(0)

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n')
    if (sep < 0) break
    const header = buf.slice(0, sep).toString('utf8')
    const m = /Content-Length:\s*(\d+)/i.exec(header)
    const start = sep + 4
    if (!m) {
      buf = buf.slice(start)
      continue
    }
    const len = Number(m[1])
    if (buf.length < start + len) break
    const body = buf.slice(start, start + len).toString('utf8')
    buf = buf.slice(start + len)
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      continue
    }
    handle(msg)
  }
})

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n')
  process.stdout.write(body)
}

function publish(uri, text) {
  const diagnostics = []
  if (typeof text === 'string' && text.indexOf('BROKEN') >= 0) {
    diagnostics.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
      severity: 1,
      message: 'mock error: BROKEN token found',
      source: 'mock'
    })
  }
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri, diagnostics }
  })
}

function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1 } } })
      return
    case 'textDocument/didOpen': {
      const d = msg.params.textDocument
      publish(d.uri, d.text || '')
      return
    }
    case 'textDocument/didChange': {
      const uri = msg.params.textDocument.uri
      const changes = msg.params.contentChanges || []
      const text = changes.length ? changes[changes.length - 1].text : ''
      publish(uri, text)
      return
    }
    case 'shutdown':
      send({ jsonrpc: '2.0', id: msg.id, result: null })
      return
    case 'exit':
      process.exit(0)
  }
}
