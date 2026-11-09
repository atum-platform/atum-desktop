// What a crash can leave in a brain root, and how it is settled before anything else.
//
// Two operations replace GBrain's whole home directory, each with two renames: the live
// home aside, then the new one in.
//  - Compaction sets the old home aside as `gbrain-retired-*` and moves `gbrain-next`
//    (built from live pages) in.
//  - A restore sets the live home aside as `replaced-*` and moves the backup's home,
//    extracted under `restore-*`, in.
// A crash between the two renames leaves no live home and one aside. The aside was the
// live home, and the ledger agrees with it, so it is moved back: the interrupted
// operation hasn't happened (a compaction's purge debt is still owed, so it runs again; a
// restore is run again from its archive). Once a live home is in place, everything else
// is a leftover (an aside, a half-built `gbrain-next`, a restore's staging) that can hold
// withdrawn text, so it is deleted, whether or not the home holds a datastore.

import { closeSync, existsSync, fsyncSync, openSync } from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const NEXT_DIR = 'gbrain-next';
const ASIDE = /^(gbrain-retired-|replaced-)/;
const STAGING = /^restore-/;

/** Make a directory's entries (a rename, a new file) durable. Best effort where a platform can't. */
export function fsyncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    /* not every platform can fsync a directory */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const isAside = (name) => ASIDE.test(name);
export const isLeftover = (name) => name === NEXT_DIR || ASIDE.test(name) || STAGING.test(name);

/**
 * Settle a root after a crash: roll an interrupted swap back, then delete leftovers.
 * Returns { rolledBack, removed }. With no live home and several asides the state is
 * ambiguous: a start refuses it (`datastore_ambiguous`); a restore passes
 * `ambiguous: 'keep'` and leaves them, since it replaces the home and then removes them.
 */
export async function recoverInterrupted(paths, { log = () => {}, ambiguous = 'refuse' } = {}) {
  const names = (await readdir(paths.root)).sort();
  let rolledBack = null;
  if (!existsSync(paths.gbrainHome)) {
    const asides = names.filter(isAside);
    if (asides.length > 1) {
      if (ambiguous === 'keep') return { rolledBack: null, removed: [] };
      throw Object.assign(new Error(`several set-aside datastores and no live one (${asides.join(', ')})`), { code: 'datastore_ambiguous' });
    }
    if (asides.length === 1) {
      await rename(join(paths.root, asides[0]), paths.gbrainHome);
      fsyncDirectory(paths.root);
      rolledBack = asides[0];
      log(`rolled back an interrupted ${asides[0].startsWith('replaced-') ? 'restore' : 'compaction'}`);
    }
  }
  const removed = [];
  for (const name of names) {
    if (name === rolledBack || !isLeftover(name)) continue;
    await rm(join(paths.root, name), { recursive: true, force: true });
    removed.push(name);
  }
  if (removed.length > 0) {
    fsyncDirectory(paths.root);
    log(`removed what an interrupted operation left: ${removed.join(', ')}`);
  }
  return { rolledBack, removed };
}
