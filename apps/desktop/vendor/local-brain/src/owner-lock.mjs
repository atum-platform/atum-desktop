// One owning process per brain root. RT's supervisor starts one service per account on
// a Mac, every agent goes through it, and a second start on the same root is refused.
// GBrain's own native lock on the PGLite datastore is the second, independent guard.
//
// The lock file is published with link(2), which fails when the name exists, so two
// starters can't both win. A lock whose process is gone is stale: it is renamed away
// (only one contender's rename succeeds) and the start retries.

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';

export class OwnerLockHeld extends Error {
  constructor(holder) {
    super(`another local brain process (pid ${holder?.pid ?? 'unknown'}) owns this root`);
    this.code = 'owner_lock_held';
    this.holder = holder;
  }
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function processCommand(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return null;
  }
}

/** A holder is live when its PID runs and, where `ps` can say, it is still a local brain. */
export function holderIsLive(holder, { alive = processAlive, command = processCommand } = {}) {
  if (!holder || !alive(holder.pid)) return false;
  if (holder.hostname && holder.hostname !== hostname()) return true; // another machine: never steal
  const running = command(holder.pid);
  if (running === null) return true; // can't tell: assume it is the owner
  return running.includes(holder.marker ?? 'local-brain');
}

function readHolder(lockFile) {
  try {
    return JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    return null; // unreadable: treated as held, never stolen blindly
  }
}

export function acquireOwnerLock(lockFile, { marker = 'local-brain', live = holderIsLive, attempts = 3 } = {}) {
  const record = { pid: process.pid, nonce: randomUUID(), hostname: hostname(), marker, startedAt: new Date().toISOString() };
  const temporary = `${lockFile}.${record.nonce}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        linkSync(temporary, lockFile);
        return {
          record,
          release() {
            const holder = readHolder(lockFile);
            if (holder && holder.nonce === record.nonce) unlinkSync(lockFile);
          },
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const holder = readHolder(lockFile);
      if (holder === undefined) continue; // released meanwhile
      if (holder === null || live(holder)) throw new OwnerLockHeld(holder);
      // Break the stale lock, then make sure what was moved aside is the stale holder's
      // and not a lock another starter published in between; if it isn't, put it back.
      const aside = `${lockFile}.stale.${record.nonce}`;
      try {
        renameSync(lockFile, aside);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const moved = readHolder(aside);
      if (moved && moved.nonce !== holder.nonce) {
        try {
          linkSync(aside, lockFile);
        } finally {
          unlinkSync(aside);
        }
        throw new OwnerLockHeld(moved);
      }
      unlinkSync(aside);
    }
    throw new OwnerLockHeld(readHolder(lockFile));
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already gone */
    }
  }
}
