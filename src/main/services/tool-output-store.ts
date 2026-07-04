/**
 * Disk-backed tool-output store — the "don't lose it, spill it" half of Phase 9.
 *
 * When a tool result is too big to keep in the model's context, we write the
 * full text to a per-session file under the app's data dir and hand the model a
 * head/tail preview plus a pointer to that file. The `read` tool is allowed to
 * reach this managed directory (see `isManagedToolOutputPath`), so the model can
 * pull the rest on demand instead of silently losing everything past an 8k cut.
 * Files are swept after a week. Modeled on opencode's `tool-output-store.ts`.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  countLines,
  needsTruncation,
  previewText,
  TOOL_PREVIEW_CHARS,
  TOOL_PREVIEW_LINES
} from '../../shared/context'

const MANAGED_DIR = 'tool-output'
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** The managed directory all spilled tool outputs live under. */
export function toolOutputRoot(): string {
  return path.join(app.getPath('userData'), MANAGED_DIR)
}

/** True when `abs` resolves inside the managed tool-output directory. */
export function isManagedToolOutputPath(abs: string): boolean {
  if (!path.isAbsolute(abs)) return false
  const root = toolOutputRoot()
  const rel = path.relative(root, path.resolve(abs))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Keep filesystem-hostile characters out of the path segments we build. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  return cleaned || 'x'
}

/**
 * Return `text` unchanged when it fits the model context; otherwise write the
 * full text to disk and return a head/tail preview with a pointer to the file.
 * A write failure degrades gracefully to an in-memory preview (never throws).
 */
export async function boundToolOutput(
  sessionId: string,
  callId: string,
  text: string
): Promise<string> {
  if (!needsTruncation(text)) return text
  const lines = countLines(text)
  try {
    const dir = path.join(toolOutputRoot(), safeSegment(sessionId || 'session'))
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `tool_${safeSegment(callId || String(Date.now()))}.txt`)
    await fs.writeFile(file, text, 'utf8')
    const marker =
      `…[output truncated: ${text.length} chars / ${lines} lines. ` +
      `Full output saved to ${file} — use the read tool on that path for the rest.]…`
    return previewText(text, { marker, maxLines: TOOL_PREVIEW_LINES, maxChars: TOOL_PREVIEW_CHARS })
  } catch {
    // Disk unavailable — fall back to a self-contained preview so the loop still runs.
    const marker = `…[output truncated to a preview: ${text.length} chars / ${lines} lines total]…`
    return previewText(text, { marker, maxLines: TOOL_PREVIEW_LINES, maxChars: TOOL_PREVIEW_CHARS })
  }
}

/** Delete spilled tool outputs older than the retention window. Best-effort. */
export async function cleanupToolOutputs(): Promise<void> {
  const root = toolOutputRoot()
  const cutoff = Date.now() - RETENTION_MS
  let sessions: string[]
  try {
    sessions = await fs.readdir(root)
  } catch {
    return // nothing written yet
  }
  for (const session of sessions) {
    const dir = path.join(root, session)
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of files) {
      const file = path.join(dir, name)
      try {
        const stat = await fs.stat(file)
        if (stat.mtimeMs < cutoff) await fs.rm(file, { force: true })
      } catch {
        // ignore individual sweep failures
      }
    }
    // Drop the session folder if it emptied out.
    try {
      if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir)
    } catch {
      // ignore
    }
  }
}
