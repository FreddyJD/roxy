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
 * The full current schema as idempotent DDL, used ONLY by the repair step at the
 * end of the ladder.
 *
 * Generated from a database migrated through every step above, so it can't drift
 * into describing a schema that never existed — transcribing it by hand got the
 * `credentials` and `mcp_servers` column names wrong on the first attempt.
 * Regenerate it when adding a table; a table missing from here simply won't be
 * self-healed.
 *
 * This does NOT replace the migrations: they still carry ordering and data
 * transformations. This is a safety net for databases whose version counter ran
 * ahead of what they actually contain.
 */
const REPAIR_SCHEMA_SQL = /* sql */ `
  CREATE TABLE IF NOT EXISTS activity (
        day   TEXT PRIMARY KEY,
        turns INTEGER NOT NULL DEFAULT 0
      );
  CREATE TABLE IF NOT EXISTS chats (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        provider_id TEXT,
        model       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      , workspace_path TEXT, kind TEXT NOT NULL DEFAULT 'session', context_summary TEXT, context_summary_at INTEGER, parent_id TEXT, description TEXT, tasks TEXT, sort_order INTEGER NOT NULL DEFAULT 0, worktree_path TEXT, branch TEXT, dev_port INTEGER, worktree_pending TEXT);
  CREATE TABLE IF NOT EXISTS credentials (
        provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        data        TEXT NOT NULL,
        encrypted   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
  CREATE TABLE IF NOT EXISTS integrations (
        id         TEXT PRIMARY KEY,
        enabled    INTEGER NOT NULL DEFAULT 0,
        config     TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
  CREATE TABLE IF NOT EXISTS loops (
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
  CREATE TABLE IF NOT EXISTS mcp_servers (
        id         TEXT PRIMARY KEY,
        config     TEXT NOT NULL DEFAULT '{}',
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
  CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      , parts TEXT);
  CREATE TABLE IF NOT EXISTS pinned_models (
        provider_id TEXT NOT NULL,
        model       TEXT NOT NULL,
        pinned_at   INTEGER NOT NULL,
        PRIMARY KEY (provider_id, model)
      );
  CREATE TABLE IF NOT EXISTS projects (
        path       TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
  CREATE TABLE IF NOT EXISTS providers (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        wire          TEXT NOT NULL,
        auth          TEXT NOT NULL,
        base_url      TEXT,
        default_model TEXT,
        enabled       INTEGER NOT NULL DEFAULT 1,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      );
  CREATE TABLE IF NOT EXISTS queue (
        id         TEXT PRIMARY KEY,
        chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      , images TEXT);
  CREATE TABLE IF NOT EXISTS recent_models (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        model       TEXT NOT NULL,
        used_at     INTEGER NOT NULL
      );
  CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
  CREATE TABLE IF NOT EXISTS usage (
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
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_queue_chat ON queue(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_recent_models_provider ON recent_models(provider_id, used_at DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage(provider_id, created_at);
`

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

  // ---- v14: per-model-call token usage (powers the cost/usage dashboard) ----
  // One row per model call (main turn, subagent, or loop). Costs are priced at
  // record time from the models.dev catalog so historical spend never shifts when
  // prices change; tokens are real provider `usage` when available, else an
  // estimate (estimated=1). chat_id is nullable + ON DELETE SET NULL so deleting a
  // session keeps its spend in the lifetime totals.
  //
  // Keeps position 14: it shipped in v0.0.43, so every installed database already
  // counts it as v14. The worktree steps below were developed in parallel and
  // originally claimed this same number — that collision is what the reconcile
  // step at the end repairs.
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
  `,

  // ---- v15: git-worktree-backed sessions ----
  // A session can run in its own `git worktree` — an isolated checkout of the
  // same repo on its own branch — so several agents work in parallel without
  // sharing one filesystem. All three columns are NULL for a normal session,
  // which keeps the previous behaviour exactly (see services/workspace.ts).
  //   worktree_path — the worktree's directory, or NULL to work in place
  //   branch        — the branch checked out there (mirrors git; git is truth)
  //   dev_port      — the port this session's dev server owns, so N sessions
  //                   don't all fight over :3000
  //
  // Idempotent, not raw ALTER: these columns were briefly published at position
  // 14, so some databases already have them at a LOWER version than this step.
  (db) => {
    addColumnIfMissing(db, 'chats', 'worktree_path', 'TEXT')
    addColumnIfMissing(db, 'chats', 'branch', 'TEXT')
    addColumnIfMissing(db, 'chats', 'dev_port', 'INTEGER')
  },

  // ---- v16: pending worktree intent ----
  // Worktrees are materialized LAZILY, on a session's first turn rather than at
  // create time, so an abandoned composer never leaves an orphan directory on
  // disk. The requested mode/branch is parked here as JSON and cleared once the
  // worktree exists (or once creation fails and we fall back to the project
  // folder). Idempotent for the same reason as v15.
  (db) => {
    addColumnIfMissing(db, 'chats', 'worktree_pending', 'TEXT')
  },

  // ---- v17: per-session inference config ----
  // Model/mode/effort/context used to be GLOBAL, so switching the model in one
  // session switched it everywhere - including sessions mid-conversation on a
  // different model. Each session now pins its own config, stamped from the
  // global settings at create time (see repo.createChat + seedSessionConfig),
  // which makes both behaviours users expect fall out at once: sessions stay
  // independent, and a new one starts from whatever you last chose.
  //
  // `provider_id` and `model` already existed from v1 but were DEAD columns -
  // written as NULL by createChat and never read except by the usage backfill.
  // They go live here; the three below join them.
  //
  // NULL everywhere means "never chosen" and resolves to the global default, so
  // every session that predates this keeps behaving exactly as it did before.
  (db) => {
    addColumnIfMissing(db, 'chats', 'agent_id', 'TEXT')
    addColumnIfMissing(db, 'chats', 'reasoning_effort', 'TEXT')
    addColumnIfMissing(db, 'chats', 'context_limit', 'INTEGER')
  },

  // ---- v18: durable activity ledger (the contribution graph's own memory) ----
  // The graph used to COUNT assistant messages live. But messages are ON DELETE
  // CASCADE from chats, so deleting a session - or removing a folder, which
  // deletes every session under it - silently erased months of green squares.
  // Activity is a record of what you DID, not a view over what you still keep,
  // and the two must not share a lifetime.
  //
  // So: one append-only row per local calendar day, incremented as turns happen
  // and never cascaded from anything. Tiny (365 rows/year), independent of
  // session retention, and the only history that has to survive a cleanup.
  //
  // The backfill re-derives the ledger from the messages still present, using
  // SQLite's 'localtime' so the buckets match `localDay` in the renderer. Turns
  // already deleted before this upgrade are gone for good - nothing recorded
  // them - but everything still on disk is preserved on the way in.
  /* sql */ `
    CREATE TABLE IF NOT EXISTS activity (
      day   TEXT PRIMARY KEY,
      turns INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO activity(day, turns)
      SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*)
      FROM messages
      WHERE role = 'assistant'
      GROUP BY day;
  `,

  // ---- v19: recent model picks + user-orderable providers ----
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recent_models (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        model       TEXT NOT NULL,
        used_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recent_models_provider ON recent_models(provider_id, used_at DESC);
    `)
    addColumnIfMissing(db, 'providers', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
    db.exec('UPDATE providers SET sort_order = -created_at WHERE sort_order = 0')
  },

  // ---- v20: pinned models ----
  // A user-chosen shortlist, independent of usage - unlike recent_models (which
  // reorders itself as you pick things), a pin only moves when the user
  // explicitly toggles it. No cap, no MRU: pinned_at just breaks ties by pin
  // order (oldest pin first).
  /* sql */ `
    CREATE TABLE IF NOT EXISTS pinned_models (
      provider_id TEXT NOT NULL,
      model       TEXT NOT NULL,
      pinned_at   INTEGER NOT NULL,
      PRIMARY KEY (provider_id, model)
    );
  `
]

/**
 * Re-assert the entire schema, repairing anything an earlier version skipped.
 *
 * This is deliberately NOT a migration. `user_version` is only a COUNTER of how
 * many steps have run — it says nothing about what the database actually
 * contains, and a database whose counter is already final skips every step in
 * the ladder, including any repair placed there. So this runs unconditionally on
 * every open, after the migrations.
 *
 * Databases end up in that state whenever the counter runs ahead of reality:
 * two branches shipping a migration under the same number (the usage dashboard
 * and the worktree columns were both "v14"), a partially-applied upgrade, a
 * restored backup. Each surfaces much later as a runtime crash — "no such
 * column: worktree_path", "no such table: projects" — that the migration system
 * can never fix, because it believes there is nothing left to do.
 *
 * Every statement is idempotent (CREATE IF NOT EXISTS, add-column-if-absent), so
 * on a healthy database this does nothing measurable. It restores STRUCTURE
 * only and never invents data, with one exception called out below where the
 * data is purely derived and can be rebuilt exactly.
 */
export function repairSchema(db: Database): void {
  db.exec(REPAIR_SCHEMA_SQL)
  // Columns added by later migrations: CREATE TABLE IF NOT EXISTS won't add
  // them to a table that already exists.
  addColumnIfMissing(db, 'chats', 'worktree_path', 'TEXT')
  addColumnIfMissing(db, 'chats', 'branch', 'TEXT')
  addColumnIfMissing(db, 'chats', 'dev_port', 'INTEGER')
  addColumnIfMissing(db, 'chats', 'worktree_pending', 'TEXT')
  // v17's per-session inference config.
  addColumnIfMissing(db, 'chats', 'agent_id', 'TEXT')
  addColumnIfMissing(db, 'chats', 'reasoning_effort', 'TEXT')
  addColumnIfMissing(db, 'chats', 'context_limit', 'INTEGER')
  // v19's provider order and recent-models table.
  addColumnIfMissing(db, 'providers', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
  db.exec(`
    CREATE TABLE IF NOT EXISTS recent_models (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      model       TEXT NOT NULL,
      used_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recent_models_provider ON recent_models(provider_id, used_at DESC);
  `)
  db.exec('UPDATE providers SET sort_order = -created_at WHERE sort_order = 0')
  // v20's pinned-models table.
  db.exec('CREATE TABLE IF NOT EXISTS pinned_models (provider_id TEXT NOT NULL, model TEXT NOT NULL, pinned_at INTEGER NOT NULL, PRIMARY KEY (provider_id, model))')
  // `projects` is derived state — one row per workspace folder its sessions use
  // — so a restored table can be rebuilt from the chats themselves, exactly as
  // v13 did on first upgrade. Only when empty, so a hand-ordered project list is
  // never clobbered.
  const rows = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }
  if (rows.n === 0) {
    db.exec(`
      INSERT OR IGNORE INTO projects(path, sort_order, created_at)
        SELECT workspace_path,
               ROW_NUMBER() OVER (ORDER BY MAX(sort_order) DESC) - 1,
               MIN(created_at)
        FROM chats
        WHERE workspace_path IS NOT NULL
        GROUP BY workspace_path;
    `)
  }
  // The activity ledger is append-only and CANNOT be rebuilt once its source
  // messages are deleted, so it is only ever seeded (never reconciled) - and
  // only when completely empty, which means the table itself was just restored
  // by the DDL above. A ledger with any row in it is the record of record.
  const led = db.prepare('SELECT COUNT(*) AS n FROM activity').get() as { n: number }
  if (led.n === 0) {
    db.exec(`
      INSERT OR IGNORE INTO activity(day, turns)
        SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*)
        FROM messages
        WHERE role = 'assistant'
        GROUP BY day;
    `)
  }
}
