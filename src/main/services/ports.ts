/**
 * Per-session dev-server ports.
 *
 * Three agents in three worktrees all running `npm run dev` will all try to
 * bind :3000 and two of them will die. Worktrees isolate the filesystem; they do
 * nothing about the network, so each session gets its own port.
 *
 * A port is allocated once, when the session's worktree is created, and stored
 * on the chat row. It must stay STABLE across restarts — a bookmarked
 * localhost:3101, an open browser tab, and a running dev server all assume it
 * doesn't move, so nothing here ever re-allocates on load.
 */
import net from 'node:net'
import * as repo from '../db/repo'

/**
 * Where per-session ports start. Deliberately above the usual defaults (3000,
 * 5173, 8080) so an allocated port never collides with whatever the user is
 * already running by hand outside Roxy.
 */
const PORT_RANGE_START = 3100
const PORT_RANGE_END = 3999

/** Whether a TCP port is free right now, tested by actually binding it. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    // Without exclusive, Node may share a port with another listener on some
    // platforms and report free when it isn't.
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen({ port, host: '127.0.0.1', exclusive: true })
  })
}

/**
 * Find a free port no other session has claimed.
 *
 * Checks the DB first (a session's dev server may be stopped right now, but the
 * port is still spoken for) and then binds to confirm nothing outside Roxy holds
 * it. Returns null when the range is exhausted — callers treat that as "no port
 * for this session", not as an error.
 */
export async function allocateDevPort(): Promise<number | null> {
  const taken = new Set(repo.listDevPorts())
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (taken.has(port)) continue
    if (await isPortFree(port)) return port
  }
  return null
}

/**
 * The port a session owns, allocating one on first use.
 *
 * Idempotent by design: an already-assigned port is returned untouched, so this
 * is safe to call on any path (turn start, service restart) without a session's
 * URL ever changing underneath it.
 */
export async function ensureDevPort(chatId: string): Promise<number | null> {
  const chat = repo.getChat(chatId)
  if (!chat) return null
  if (chat.devPort) return chat.devPort
  const port = await allocateDevPort()
  if (port === null) return null
  repo.setChatWorktree(chatId, { devPort: port })
  return port
}
