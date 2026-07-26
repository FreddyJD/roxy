import type { Database } from 'better-sqlite3'

/**
 * A migration is either raw SQL or a function, for steps that must INSPECT the
 * database before acting (SQLite has no `ADD COLUMN IF NOT EXISTS`).
 */
export type Migration = string | ((db: Database) => void)

/** Whether a table already has a column — SQLite can't express this in DDL. */
export function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return cols.some((c) => c.name === column)
}

/**
 * Add a column only if it's missing. Idempotent, so a repair step can run
 * against a database that's already correct.
 */
export function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  type: string
): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}

/**
 * Migrations, applied in order. The array index + 1 is the schema version
 * tracked via SQLite's `PRAGMA user_version`. Append new migrations; never edit
 * an existing one once shipped.
 *
 * CAUTION: the version is a POSITION, so two branches that each append a "v14"
 * describe different schemas by the same number. A database that ran one
 * branch's v14 will skip the other's forever, because its user_version already
 * says 14. That happened between the usage-dashboard and worktree branches —
 * see the reconcile step at the end, which repairs it.
 */
export const MIGRATIONS: Migration[] = [
  // ---- v1: initial schema ----
  /* sql */ `
    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE providers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      wire          TEXT NOT NULL,
      auth          TEXT NOT NULL,
      base_url      TEXT,
      default_model TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE credentials (
      provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      data        TEXT NOT NULL,
      encrypted   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE chats (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      provider_id TEXT,
      model       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE messages (
      id         TEXT PRIMARY KEY,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_chat ON messages(chat_id, created_at);

    CREATE TABLE integrations (
      id         TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 0,
      config     TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `,

  // ---- v2: workspace folder per session ----
  /* sql */ `ALTER TABLE chats ADD COLUMN workspace_path TEXT;`,

  // ---- v3: chat kind + loops (scheduled prompts) ----
  /* sql */ `
    ALTER TABLE chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'session';

    CREATE TABLE loops (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      prompt           TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      enabled          INTEGER NOT NULL DEFAULT 1,
      chat_id          TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      last_run_at      INTEGER,
      next_run_at      INTEGER NOT NULL,
      created_at       INTEGER NOT NULL
    );
  `,

  // ---- v4: per-chat prompt queue ----
  /* sql */ `
    CREATE TABLE queue (
      id         TEXT PRIMARY KEY,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_queue_chat ON queue(chat_id, created_at);
  `,

  // ---- v5: rename the 'session' kind to 'main' ----
  /* sql */ `UPDATE chats SET kind = 'main' WHERE kind = 'session';`,

  // ---- v6: ordered message parts (reasoning / tool / text) ----
  /* sql */ `ALTER TABLE messages ADD COLUMN parts TEXT;`,

  // ---- v7: images attached to queued messages (JSON) ----
  /* sql */ `ALTER TABLE queue ADD COLUMN images TEXT;`,

  // ---- v8: per-chat compaction summary (replaces older turns in context) ----
  /* sql */ `
    ALTER TABLE chats ADD COLUMN context_summary TEXT;
    ALTER TABLE chats ADD COLUMN context_summary_at INTEGER;
  `,

  // ---- v9: subagent sessions link back to the chat that spawned them ----
  /* sql */ `ALTER TABLE chats ADD COLUMN parent_id TEXT;`,

  // ---- v10: agent-set session metadata (description + task checklist JSON) ----
  /* sql */ `
    ALTER TABLE chats ADD COLUMN description TEXT;
    ALTER TABLE chats ADD COLUMN tasks TEXT;
  `,

  // ---- v11: external MCP (Model Context Protocol) servers ----
  /* sql */ `
    CREATE TABLE mcp_servers (
      id         TEXT PRIMARY KEY,
      config     TEXT NOT NULL DEFAULT '{}',
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `,

  // ---- v12: user-orderable sessions (drag-to-reorder within a project) ----
  // Seed each existing row with its creation time so the default order is stable
  // (newest-created first); reorders write ~now()-scale keys to float a chosen
  // order into place. Higher sort_order = higher in the list.
  /* sql */ `
    ALTER TABLE chats ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
    UPDATE chats SET sort_order = created_at;
  `,

  // ---- v13: explicit, persistent project (workspace) order ----
  // Projects used to be ordered only as a side effect of their sessions'
  // sort_order, so creating or reordering a session floated the whole project to
  // the top. Give each workspace its own order instead: it's rendered ASC (top→
  // bottom), new projects append at the bottom (MAX+1), and session activity no
  // longer touches it. Seed the initial order from each project's newest session
  // (ROW_NUMBER over MAX(sort_order) DESC) so it matches the newest-session-first
  // layout users saw right before upgrading.
  /* sql */ `
    CREATE TABLE projects (
      path       TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO projects(path, sort_order, created_at)
      SELECT workspace_path,
             ROW_NUMBER() OVER (ORDER BY MAX(sort_order) DESC) - 1,
             MIN(created_at)
      FROM chats
      WHERE workspace_path IS NOT NULL
      GROUP BY workspace_path;
  `,

  // ---- v14: git-worktree-backed sessions ----
  // A session can run in its own `git worktree` — an isolated checkout of the
  // same repo on its own branch — so several agents work in parallel without
  // sharing one filesystem. All three columns are NULL for a normal session,
  // which keeps today's behaviour exactly (see services/workspace.ts).
  //   worktree_path — the worktree's directory, or NULL to work in place
  //   branch        — the branch checked out there (mirrors git; git is truth)
  //   dev_port      — the port this session's dev server owns, so N sessions
  //                   don't all fight over :3000
  /* sql */ `
    ALTER TABLE chats ADD COLUMN worktree_path TEXT;
    ALTER TABLE chats ADD COLUMN branch TEXT;
    ALTER TABLE chats ADD COLUMN dev_port INTEGER;
  `,

  // ---- v15: pending worktree intent ----
  // Worktrees are materialized LAZILY, on a session's first turn rather than at
  // create time, so an abandoned composer never leaves an orphan directory on
  // disk. The requested mode/branch is parked here as JSON and cleared once the
  // worktree exists (or once creation fails and we fall back to working in the
  // project folder).
  /* sql */ `
    ALTER TABLE chats ADD COLUMN worktree_pending TEXT;
  `,

  // ---- v16: reconcile the worktree columns ----
  // Repairs databases that skipped an earlier migration because two branches
  // both numbered one "v14": a DB that took the other branch's v14 advanced its
  // user_version past ours, so our columns were never added and every worktree
  // write failed with "no such column: worktree_path".
  //
  // Written as a function because it must be idempotent — it runs on healthy
  // databases too, where every column already exists and it does nothing.
  (db) => {
    addColumnIfMissing(db, 'chats', 'worktree_path', 'TEXT')
    addColumnIfMissing(db, 'chats', 'branch', 'TEXT')
    addColumnIfMissing(db, 'chats', 'dev_port', 'INTEGER')
    addColumnIfMissing(db, 'chats', 'worktree_pending', 'TEXT')
  }
]
