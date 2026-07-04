/**
 * Wire protocol for the Remote Workspace relay — the desktop **host** side.
 *
 * This mirrors roxy.gg's `src/server/remote/protocol.ts`. roxy.gg is a *dumb
 * pipe*: it pairs this desktop host with one or more phone **guests** in an
 * in-memory room and shuttles opaque JSON frames between them, only ever reading
 * a frame's `t` discriminator. The desktop stays authoritative — code/files
 * never touch the server; only transcript text + agent events cross the wire.
 *
 * Keep these three in sync: roxy.gg protocol.ts (relay), this file (host), and
 * roxy.gg web/src (Part 4, the phone guest).
 */

/** Path the desktop (host) dials for the WebSocket relay. */
export const REMOTE_WS_PATH = '/api/remote/ws'

/** Roles a socket can hold in a room. Encoded into the signed token. */
export type RemoteRole = 'host' | 'guest'

// --- Guest (phone) → Host (desktop), relayed to us ------------------------

/** A prompt typed on the phone; we run it as if it were typed locally. */
export interface PromptFrame {
  t: 'prompt'
  text: string
}

/** Abort the in-flight turn. */
export interface AbortFrame {
  t: 'abort'
}

/** Frames a guest can send that the relay forwards to us. */
export type GuestFrame = PromptFrame | AbortFrame

// --- Host (desktop) → Guest (phone), sent by us ---------------------------

/** Full transcript sent to a guest right after it joins. */
export interface SnapshotFrame {
  t: 'snapshot'
  messages: unknown[]
}

/** One streamed agent event (an `LlmEvent`), relayed verbatim. */
export interface DeltaFrame {
  t: 'delta'
  event: unknown
}

/** Whether the desktop is currently running a turn (drives the phone spinner). */
export interface TurnFrame {
  t: 'turn'
  state: 'running' | 'idle'
}

/** Session metadata (title / working dir) for the phone header. */
export interface MetaFrame {
  t: 'meta'
  title?: string
  cwd?: string
}

/** A host-side error surfaced to the guest. */
export interface HostErrorFrame {
  t: 'error'
  message: string
}

/** Frames we send toward the guests. */
export type HostFrame = SnapshotFrame | DeltaFrame | TurnFrame | MetaFrame | HostErrorFrame

// --- Relay (roxy.gg) → host (control) -------------------------------------

/**
 * Control frames the *broker itself* generates. They never originate from a
 * client. We only act on the ones relevant to a host.
 */
export type ControlFrame =
  | { t: 'paired' } // legacy/no-op for host
  | { t: 'guest-joined'; guests: number } // a guest authed (PIN ok) — send it a snapshot
  | { t: 'guest-left'; guests: number } // a guest disconnected
  | { t: 'host-online' } // our own (re)connection acknowledged
  | { t: 'host-offline' } // (guests-facing; ignored by host)
  | { t: 'bye'; reason: string } // room is being torn down

/** Any frame that can arrive on the host socket. */
export type IncomingFrame = GuestFrame | ControlFrame

/**
 * Hard cap on a single relayed frame (bytes) — mirrors the server. Transcripts
 * and deltas are small text; anything larger is dropped rather than sent.
 */
export const MAX_FRAME_BYTES = 512 * 1024

/** Parse a raw socket message into a frame, or null if it isn't valid JSON. */
export function parseFrame(raw: string): { t?: string; [k: string]: unknown } | null {
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    return value as { t?: string }
  } catch {
    return null
  }
}
