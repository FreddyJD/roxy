/**
 * SQL migrations, applied in order. The array index + 1 is the schema version
 * tracked via SQLite's `PRAGMA user_version`. Append new migrations; never edit
 * an existing one once shipped.
 */
export const MIGRATIONS: string[] = [
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

  // ---- v14: per-model-call token usage (powers the cost/usage dashboard) ----
  // One row per model call (main turn, subagent, or loop). Costs are priced at
  // record time from the models.dev catalog so historical spend never shifts when
  // prices change; tokens are real provider `usage` when available, else an
  // estimate (estimated=1). chat_id is nullable + ON DELETE SET NULL so deleting a
  // session keeps its spend in the lifetime totals.
  /* sql */ `
    CREATE TABLE usage (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT REFERENCES chats(id) ON DELETE SET NULL,
      provider_id TEXT NOT NULL,
      model       TEXT NOT NULL,
      input       INTEGER NOT NULL DEFAULT 0,
      output      INTEGER NOT NULL DEFAULT 0,
      cache_read  INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      reasoning   INTEGER NOT NULL DEFAULT 0,
      cost        REAL NOT NULL DEFAULT 0,
      estimated   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_usage_created ON usage(created_at);
    CREATE INDEX idx_usage_provider ON usage(provider_id, created_at);
  `
]
