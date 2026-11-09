// Where one local brain keeps its state, and where it must never live.
//
// root/
//   owner.lock          the one owning process (owner-lock.mjs)
//   ledger/ledger.jsonl Atum's durable records: receipts, withdrawals, corrections, fence
//   gbrain/             GBRAIN_HOME for the pinned GBrain child (its .gbrain/ config)
//   gbrain/brain.pglite the PGLite datastore, opened only by that child
//   gbrain/home         HOME for the child, so it never reads or writes the person's ~/.gbrain
//   gbrain/tmp          TMPDIR for the child (PGLite extension assets)
//   backups/            archives made by `backup`
//   gbrain-next/        a fresh datastore being built by `compact`, swapped in when done
//
// A live PGLite directory is never synced through Drive (or iCloud, Dropbox, Google
// Drive, OneDrive): the root is refused when it is inside one, and RT passes Atum Drive's
// own sync roots as `forbidUnder`.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

export function layout(root, { gbrainDir = 'gbrain' } = {}) {
  if (!isAbsolute(root)) throw new Error('the local brain root must be an absolute path');
  const gbrainHome = join(root, gbrainDir);
  return {
    root,
    lockFile: join(root, 'owner.lock'),
    ledgerDir: join(root, 'ledger'),
    ledgerFile: join(root, 'ledger', 'ledger.jsonl'),
    gbrainHome,
    gbrainConfigDir: join(gbrainHome, '.gbrain'),
    gbrainConfigFile: join(gbrainHome, '.gbrain', 'config.json'),
    datastore: join(gbrainHome, 'brain.pglite'),
    gbrainUserHome: join(gbrainHome, 'home'),
    gbrainTmp: join(gbrainHome, 'tmp'),
    provisionedMarker: join(gbrainHome, 'atum-provisioned.json'),
    backups: join(root, 'backups'),
  };
}

/** Folders that sync their contents to a cloud service on macOS. */
export function knownSyncRoots(home = homedir()) {
  return [
    join(home, 'Library', 'CloudStorage'),
    join(home, 'Library', 'Mobile Documents'),
    join(home, 'Dropbox'),
    join(home, 'Google Drive'),
    join(home, 'OneDrive'),
    join(home, 'iCloud Drive'),
  ];
}

// The ownCloud and OpenCloud desktop clients keep a journal database such as
// `.sync_1a2b3c.db` or `._sync_1a2b3c.db` at the top of every synced folder.
const SYNC_JOURNAL = /^\.?_?sync_[0-9a-f]+\.db$/i;

function realOrResolved(path) {
  // The root may not exist yet: resolve its nearest existing ancestor instead.
  let current = resolve(path);
  const missing = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(parse(current).base);
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync(current);
  } catch {
    /* keep the resolved path */
  }
  return join(real, ...missing);
}

function isInside(child, parent) {
  const c = realOrResolved(child);
  const p = realOrResolved(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

/**
 * Refuse a root inside a synced folder. Returns the reason, or null when the root is
 * safe. `forbidUnder` holds Atum Drive's sync roots, which only RT knows.
 */
export function syncedFolderReason(root, { forbidUnder = [], home = homedir() } = {}) {
  for (const syncRoot of [...knownSyncRoots(home), ...forbidUnder]) {
    if (isInside(root, syncRoot)) return `inside the synced folder ${syncRoot}`;
  }
  let current = realOrResolved(root);
  while (true) {
    if (existsSync(current)) {
      let entries = [];
      try {
        entries = readdirSync(current);
      } catch {
        entries = [];
      }
      const journal = entries.find((name) => SYNC_JOURNAL.test(name));
      if (journal) return `inside a folder synced by a Drive client (${join(current, journal)})`;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function assertNotSynced(root, options) {
  const reason = syncedFolderReason(root, options);
  if (reason) {
    const error = new Error(`refusing a local brain root ${reason}: a live PGLite directory is never synced`);
    error.code = 'root_in_synced_folder';
    throw error;
  }
}
