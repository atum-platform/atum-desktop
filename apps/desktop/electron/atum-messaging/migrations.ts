import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface MessagingMigration {
  version: number
  name: string
  sql: string
}

export const MESSAGING_MIGRATIONS: readonly MessagingMigration[] = [
  {
    version: 1,
    name: 'account_partitioned_projection',
    sql: `
      CREATE TABLE messaging_conversations (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT,
        kind TEXT NOT NULL,
        participant_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
        payload_json TEXT NOT NULL,
        PRIMARY KEY (account_id, id)
      ) STRICT;

      CREATE INDEX messaging_conversations_roster_idx
        ON messaging_conversations(account_id, last_message_at DESC, updated_at DESC, id DESC);

      CREATE TABLE messaging_messages (
        local_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        canonical_id TEXT,
        client_message_id TEXT,
        sender_type TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        kind TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        reply_to_message_id TEXT,
        forwarded_from_json TEXT,
        reactions_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 0),
        created_at TEXT NOT NULL,
        edited_at TEXT,
        recalled_at TEXT,
        delivery TEXT NOT NULL,
        sort_at TEXT NOT NULL,
        optimistic INTEGER NOT NULL CHECK (optimistic IN (0, 1)),
        FOREIGN KEY (account_id, conversation_id)
          REFERENCES messaging_conversations(account_id, id) ON DELETE CASCADE,
        UNIQUE (account_id, canonical_id),
        UNIQUE (account_id, conversation_id, client_message_id)
      ) STRICT;

      CREATE INDEX messaging_messages_timeline_idx
        ON messaging_messages(account_id, conversation_id, sort_at DESC, local_id DESC);

      CREATE TABLE messaging_drafts (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL,
        reply_to_message_id TEXT,
        attachment_ids_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, conversation_id)
      ) STRICT;

      CREATE TABLE messaging_sync_state (
        account_id TEXT PRIMARY KEY,
        cursor TEXT,
        updated_at TEXT
      ) STRICT;
    `
  },
  {
    version: 2,
    name: 'durable_mutation_outbox',
    sql: `
      CREATE TABLE messaging_pending_mutations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind = 'send_message'),
        request_json TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'sending', 'sent', 'failed_retryable', 'failed_terminal', 'conflicted'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        last_error_code TEXT,
        draft_revision INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_id, conversation_id, client_message_id)
      ) STRICT;

      CREATE INDEX messaging_mutations_due_idx
        ON messaging_pending_mutations(account_id, state, next_attempt_at, created_at);

      CREATE TABLE messaging_read_state (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_read_message_id TEXT NOT NULL,
        last_read_sort_at TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (account_id, conversation_id),
        FOREIGN KEY (account_id, conversation_id)
          REFERENCES messaging_conversations(account_id, id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE messaging_sync_changes (
        account_id TEXT NOT NULL,
        change_id TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY (account_id, change_id)
      ) STRICT;
    `
  },
  {
    version: 3,
    name: 'message_metadata',
    sql: `
      ALTER TABLE messaging_messages ADD COLUMN metadata_json TEXT;
    `
  },
  {
    version: 4,
    name: 'durable_read_receipt_outbox',
    sql: `
      CREATE TABLE messaging_pending_read_receipts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        through_message_id TEXT NOT NULL,
        client_operation_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'failed_retryable')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_id, conversation_id)
      ) STRICT;

      CREATE INDEX messaging_read_receipts_due_idx
        ON messaging_pending_read_receipts(account_id, state, next_attempt_at, created_at);
    `
  },
  {
    version: 5,
    name: 'social_relationship_projection',
    sql: `
      CREATE TABLE messaging_social_state (
        account_id TEXT PRIMARY KEY,
        account_epoch TEXT NOT NULL,
        cursor TEXT
      ) STRICT;

      CREATE TABLE messaging_social_relationships (
        account_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        handle TEXT NOT NULL,
        verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
        avatar TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'none', 'outgoing_pending', 'incoming_pending', 'connected', 'blocked_by_me'
        )),
        version INTEGER NOT NULL CHECK (version >= 0),
        can_message INTEGER NOT NULL CHECK (can_message IN (0, 1)),
        direct_thread_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, profile_id),
        UNIQUE (account_id, direct_thread_id),
        CHECK (can_message = CASE WHEN state = 'connected' AND direct_thread_id IS NOT NULL THEN 1 ELSE 0 END)
      ) STRICT;

      CREATE INDEX messaging_social_relationships_roster_idx
        ON messaging_social_relationships(account_id, updated_at DESC, profile_id);
    `
  },
  {
    version: 6,
    name: 'human_group_durability',
    sql: `
      CREATE TABLE messaging_group_operations (
        account_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        conversation_id TEXT, membership_epoch INTEGER,
        request_json TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','sending','sent','failed_retryable','failed_terminal','conflicted')),
        attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
        error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, operation_id)
      ) STRICT;
      CREATE INDEX messaging_group_operations_due_idx
        ON messaging_group_operations(account_id,state,next_attempt_at,created_at);
      CREATE TABLE messaging_group_revocations (
        account_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        membership_epoch INTEGER NOT NULL, PRIMARY KEY(account_id,conversation_id)
      ) STRICT;
      CREATE TABLE messaging_group_details (
        account_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        detail_json TEXT NOT NULL, PRIMARY KEY(account_id,conversation_id),
        FOREIGN KEY(account_id,conversation_id) REFERENCES messaging_conversations(account_id,id) ON DELETE CASCADE
      ) STRICT;
    `
  }
]

function checksum(migration: MessagingMigration): string {
  return createHash('sha256').update(`${migration.version}\n${migration.name}\n${migration.sql}`, 'utf8').digest('hex')
}

export function applyMessagingMigrations(
  database: DatabaseSync,
  targetVersion = MESSAGING_MIGRATIONS.at(-1)?.version ?? 0
): void {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
    throw new Error(`Invalid messaging migration target: ${targetVersion}`)
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS messaging_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `)

  const knownByVersion = new Map(MESSAGING_MIGRATIONS.map(migration => [migration.version, migration]))

  if (targetVersion !== 0 && !MESSAGING_MIGRATIONS.some(migration => migration.version === targetVersion)) {
    throw new Error(`Unknown messaging migration target: ${targetVersion}`)
  }

  const insert = database.prepare(`
    INSERT INTO messaging_schema_migrations(version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `)

  database.exec('BEGIN IMMEDIATE')

  try {
    // Read migration history only after taking the write lock. A second process
    // opening the same fresh account database must observe the first opener's
    // completed migration instead of replaying a stale pending list.
    const rows = database
      .prepare('SELECT version, name, checksum FROM messaging_schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string; checksum: string }>

    for (const row of rows) {
      const known = knownByVersion.get(row.version)

      if (!known || known.name !== row.name || checksum(known) !== row.checksum) {
        throw new Error(`Unknown or modified messaging migration at version ${row.version}`)
      }
    }

    const currentVersion = rows.at(-1)?.version ?? 0

    const pragmaVersion = Number(
      (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    )

    if (pragmaVersion !== currentVersion) {
      throw new Error(`Messaging schema history is inconsistent: PRAGMA=${pragmaVersion}, history=${currentVersion}`)
    }

    if (currentVersion > targetVersion) {
      throw new Error(`Messaging schema ${currentVersion} is newer than supported target ${targetVersion}`)
    }

    const pending = MESSAGING_MIGRATIONS.filter(
      migration => migration.version > currentVersion && migration.version <= targetVersion
    )

    for (const migration of pending) {
      database.exec(migration.sql)
      insert.run(migration.version, migration.name, checksum(migration), new Date().toISOString())
    }

    database.exec(`PRAGMA user_version = ${targetVersion}`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
