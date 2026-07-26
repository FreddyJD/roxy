import { join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { MIGRATIONS, repairSchema } from './migrations'

let instance: Database.Database | null = null

/** Lazily open the SQLite database, applying migrations on first access. */
export function getDb(): Database.Database {
  if (instance) return instance

  const file = join(app.getPath('userData'), 'roxy.db')
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  // Then re-assert the schema, unconditionally. `user_version` counts the steps
  // that RAN, not what the database contains: a counter that ran ahead of
  // reality (two branches numbering a migration the same, a partial upgrade, a
  // restored backup) leaves a DB that skips the whole ladder while missing a
  // table or column, and only crashes later at runtime. This is idempotent, so
  // it costs nothing when everything is already correct.
  repairSchema(db)

  instance = db
  return instance
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version++) {
    const step = MIGRATIONS[version]
    const apply = db.transaction(() => {
      // A step is raw SQL, or a function for one that must inspect the schema
      // first (SQLite has no ADD COLUMN IF NOT EXISTS).
      if (typeof step === 'string') db.exec(step)
      else step(db)
      db.pragma(`user_version = ${version + 1}`)
    })
    apply()
  }
}

export function closeDb(): void {
  instance?.close()
  instance = null
}
