import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const fixtureRoot = path.join(import.meta.dirname, '__fixtures__')

/** Tests create disposable databases from checked-in SQL; no owner database is ever opened. */
export function createFixtureDatabase(name: 'messages' | 'safari-history' | 'chrome-history', file: string): string {
  mkdirSync(path.dirname(file), { recursive: true })
  const database = new DatabaseSync(file)

  try {
    // These databases exercise read semantics, not crash durability. Build each
    // fixture in one non-durable transaction so dozens of schema/INSERT
    // statements do not each fsync a shared CI disk.
    database.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; BEGIN IMMEDIATE;')

    try {
      database.exec(readFileSync(path.join(fixtureRoot, `${name}.sql`), 'utf8'))
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
  } finally {
    database.close()
  }

  return file
}
