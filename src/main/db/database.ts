import { join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { MIGRATIONS } from './migrations'

let instance: Database.Database | null = null

/** Lazily open the SQLite database, applying migrations on first access. */
export function getDb(): Database.Database {
  if (instance) return instance

  const file = join(app.getPath('userData'), 'roxy.db')
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)

  instance = db
  return instance
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version]
    const apply = db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${version + 1}`)
    })
    apply()
  }
}

export function closeDb(): void {
  instance?.close()
  instance = null
}
