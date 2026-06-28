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
  /* sql */ `ALTER TABLE chats ADD COLUMN parent_id TEXT;`
]
