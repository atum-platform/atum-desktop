// The ledger's durability, the owner lock, and where a brain may live.

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ledger, LedgerCorrupt, isPrefixLedger } from '../src/ledger.mjs';
import { OwnerLockHeld, acquireOwnerLock, holderIsLive } from '../src/owner-lock.mjs';
import { assertNotSynced, knownSyncRoots, layout, syncedFolderReason } from '../src/paths.mjs';
import { recoverInterrupted } from '../src/recovery.mjs';
import { backupEntries } from '../src/service.mjs';
import { removeRoot, tempRoot } from './helpers.mjs';

test('an interrupted restore rolls back its sole old home and removes only operation leftovers', async () => {
  const root = tempRoot();
  try {
    const paths = layout(root);
    mkdirSync(join(root, 'replaced-1'));
    writeFileSync(join(root, 'replaced-1', 'proof'), 'live state');
    mkdirSync(join(root, 'restore-2'));
    writeFileSync(join(root, 'restore-2', 'proof'), 'partial incoming');
    mkdirSync(join(root, 'unrelated'));
    const result = await recoverInterrupted(paths);
    assert.equal(result.rolledBack, 'replaced-1');
    assert.equal(readFileSync(join(paths.gbrainHome, 'proof'), 'utf8'), 'live state');
    assert.deepEqual(result.removed, ['restore-2']);
    assert.equal(existsSync(join(root, 'unrelated')), true);
  } finally {
    removeRoot(root);
  }
});

test('ambiguous interrupted homes are preserved, never guessed or deleted', async () => {
  const root = tempRoot();
  try {
    const paths = layout(root);
    for (const name of ['replaced-1', 'gbrain-retired-2', 'restore-3']) mkdirSync(join(root, name));
    await assert.rejects(recoverInterrupted(paths), (error) => error.code === 'datastore_ambiguous');
    assert.deepEqual(await recoverInterrupted(paths, { ambiguous: 'keep' }), { rolledBack: null, removed: [] });
    for (const name of ['replaced-1', 'gbrain-retired-2', 'restore-3']) assert.equal(existsSync(join(root, name)), true);
  } finally {
    removeRoot(root);
  }
});

test('every private backup entry uses owner-only modes, including marker and ledger', async () => {
  const root = tempRoot();
  try {
    const paths = layout(root);
    for (const dir of [paths.datastore, paths.gbrainConfigDir, paths.ledgerDir]) mkdirSync(dir, { recursive: true });
    for (const file of [join(paths.datastore, 'page'), paths.gbrainConfigFile, paths.provisionedMarker, paths.ledgerFile]) {
      writeFileSync(file, 'synthetic fixture', { mode: 0o644 });
    }
    const entries = await backupEntries(paths, { format: 'fixture' });
    for (const entry of entries) assert.equal(entry.mode, entry.type === '5' ? 0o700 : 0o600, entry.path);
    for (const name of ['manifest.json', 'ledger/ledger.jsonl', 'gbrain/atum-provisioned.json']) {
      assert.ok(entries.some((entry) => entry.path === name), name);
    }
  } finally {
    removeRoot(root);
  }
});

test('a ledger replays exactly what was appended, in order', () => {
  const dir = tempRoot();
  try {
    const path = join(dir, 'ledger.jsonl');
    const seen = [];
    const ledger = new Ledger(path, (record) => seen.push(record.type));
    ledger.open();
    ledger.append({ type: 'fence', since: 1 });
    ledger.append({ type: 'fence', since: 2 });
    ledger.close();
    const replayed = [];
    const again = new Ledger(path, (record) => replayed.push([record.seq, record.type]));
    assert.deepEqual(again.open(), { records: 3, dropped: 0 });
    assert.deepEqual(replayed, [[1, 'genesis'], [2, 'fence'], [3, 'fence']]);
    again.append({ type: 'fence', since: 3 });
    assert.equal(again.seq, 4);
    again.close();
  } finally {
    removeRoot(dir);
  }
});

test('a torn last line (never acknowledged) is dropped; a damaged middle line refuses to load', () => {
  const dir = tempRoot();
  try {
    const path = join(dir, 'ledger.jsonl');
    const ledger = new Ledger(path, () => {});
    ledger.open();
    ledger.append({ type: 'fence', since: 1 });
    ledger.close();
    appendFileSync(path, '{"seq":3,"prev":"x","type":"fen');
    const torn = new Ledger(path, () => {});
    assert.deepEqual(torn.open(), { records: 2, dropped: 1 });
    torn.append({ type: 'fence', since: 2 });
    torn.close();
    assert.equal(readFileSync(path, 'utf8').split('\n').filter(Boolean).length, 3);
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[1] = lines[1].replace('"since":1', '"since":9');
    writeFileSync(path, lines.join('\n'));
    assert.throws(() => new Ledger(path, () => {}).open(), LedgerCorrupt);
  } finally {
    removeRoot(dir);
  }
});

test('a backup\'s ledger is a prefix of the live one until they diverge', () => {
  assert.equal(isPrefixLedger('a\nb\n', 'a\nb\nc\n'), true);
  assert.equal(isPrefixLedger('a\nx\n', 'a\nb\nc\n'), false);
  assert.equal(isPrefixLedger('a\nb\nc\nd\n', 'a\nb\n'), false);
});

test('one owner per root; a dead owner\'s lock is taken over; a live one never is', () => {
  const dir = tempRoot();
  try {
    const lockFile = join(dir, 'owner.lock');
    const first = acquireOwnerLock(lockFile, { live: () => true });
    assert.throws(() => acquireOwnerLock(lockFile, { live: () => true }), OwnerLockHeld);
    const second = acquireOwnerLock(lockFile, { live: () => false }); // the first "died"
    assert.notEqual(second.record.nonce, first.record.nonce);
    first.release(); // a stale owner's release never removes the new owner's lock
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).nonce, second.record.nonce);
    second.release();
    const third = acquireOwnerLock(lockFile);
    third.release();
  } finally {
    removeRoot(dir);
  }
});

test('breaking a stale lock never removes a lock another starter published meanwhile', () => {
  const dir = tempRoot();
  try {
    const lockFile = join(dir, 'owner.lock');
    writeFileSync(lockFile, `${JSON.stringify({ pid: 999_999_999, nonce: 'stale' })}\n`);
    const racing = () => {
      // Between our reading the stale holder and breaking it, someone else took over.
      writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, nonce: 'fresh' })}\n`);
      return false;
    };
    assert.throws(() => acquireOwnerLock(lockFile, { live: racing }), OwnerLockHeld);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).nonce, 'fresh', 'the other starter keeps its lock');
  } finally {
    removeRoot(dir);
  }
});

test('liveness: a dead PID is stale, an unrelated live process is not the owner', () => {
  assert.equal(holderIsLive({ pid: 999_999_999, hostname: undefined }, { alive: () => false }), false);
  assert.equal(holderIsLive({ pid: process.pid, marker: 'local-brain' }, { alive: () => true, command: () => '/usr/bin/vim' }), false);
  assert.equal(holderIsLive({ pid: process.pid, marker: 'local-brain' }, { alive: () => true, command: () => 'node local-brain/src/cli.mjs serve' }), true);
  assert.equal(holderIsLive({ pid: process.pid }, { alive: () => true, command: () => null }), true);
});

test('never inside a synced folder: known sync roots, a Drive client journal, or RT\'s list', () => {
  const home = tempRoot('lb-home-');
  try {
    for (const syncRoot of knownSyncRoots(home)) {
      assert.match(syncedFolderReason(join(syncRoot, 'x', 'brain'), { home }), /synced folder/);
    }
    const drive = join(home, 'Atum Drive');
    mkdirSync(join(drive, 'sub'), { recursive: true });
    writeFileSync(join(drive, '._sync_abc123.db'), '');
    assert.match(syncedFolderReason(join(drive, 'sub', 'brain'), { home }), /Drive client/);
    const other = join(home, 'Elsewhere');
    assert.match(syncedFolderReason(join(other, 'brain'), { home, forbidUnder: [other] }), /synced folder/);
    const safe = join(home, 'Library', 'Application Support', 'Atum', 'local-brain');
    assert.equal(syncedFolderReason(safe, { home }), null);
    assert.throws(() => assertNotSynced(join(drive, 'brain'), { home }), /never synced/);
  } finally {
    removeRoot(home);
  }
});

test('on macOS the engine runs where it can reach no network', { skip: process.platform !== 'darwin' && 'Seatbelt is macOS only' }, async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { sandboxed } = await import('../src/gbrain.mjs');
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const fetchWith = (command, args) => new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => resolve(error ? 'refused' : stdout));
  });
  try {
    assert.equal(await fetchWith('/usr/bin/curl', ['-s', '-m', '5', url]), 'ok', 'the server answers outside the sandbox');
    const inside = sandboxed('/usr/bin/curl', ['-s', '-m', '5', url]);
    assert.equal(inside.sandboxed, true);
    assert.equal(await fetchWith(inside.command, inside.args), 'refused', 'no IP connection is possible inside, not even to localhost');
  } finally {
    server.close();
  }
});
