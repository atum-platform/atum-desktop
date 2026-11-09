import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectTree, extractArchive, writeArchive } from '../src/tar.mjs';

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'lb-tar-'));
  mkdirSync(join(dir, 'src', 'deep', 'er'), { recursive: true });
  mkdirSync(join(dir, 'empty'));
  writeFileSync(join(dir, 'src', 'a.txt'), 'alpha\n');
  writeFileSync(join(dir, 'src', 'deep', 'er', 'b.bin'), Buffer.alloc(1025, 7));
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(dir, 'zero'), '');
  return dir;
}

test('the same tree gives byte-identical archives, which system tar also reads', async () => {
  const dir = tree();
  const out = mkdtempSync(join(tmpdir(), 'lb-tar-out-'));
  try {
    const entries = await collectTree(dir, 'pkg');
    await writeArchive(entries, join(out, 'one.tar.gz'));
    await writeArchive(await collectTree(dir, 'pkg'), join(out, 'two.tar.gz'));
    assert.equal(sha(join(out, 'one.tar.gz')), sha(join(out, 'two.tar.gz')));
    const listing = execFileSync('tar', ['-tzvf', join(out, 'one.tar.gz')], { encoding: 'utf8' });
    assert.match(listing, /pkg\/src\/deep\/er\/b\.bin/);
    assert.match(listing, /rwxr-xr-x .*pkg\/run\.sh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('extraction restores contents and modes, and a round trip is lossless', async () => {
  const dir = tree();
  const out = mkdtempSync(join(tmpdir(), 'lb-tar-out-'));
  try {
    await writeArchive(await collectTree(dir, 'pkg'), join(out, 'a.tar.gz'));
    const extracted = await extractArchive(join(out, 'a.tar.gz'), join(out, 'x'));
    assert.ok(extracted.includes('pkg/empty/'));
    assert.equal(readFileSync(join(out, 'x', 'pkg', 'src', 'a.txt'), 'utf8'), 'alpha\n');
    assert.deepEqual(readFileSync(join(out, 'x', 'pkg', 'src', 'deep', 'er', 'b.bin')), Buffer.alloc(1025, 7));
    assert.equal(readFileSync(join(out, 'x', 'pkg', 'zero')).length, 0);
    assert.equal(statSync(join(out, 'x', 'pkg', 'run.sh')).mode & 0o777, 0o755);
    assert.equal(statSync(join(out, 'x', 'pkg', 'src', 'a.txt')).mode & 0o777, 0o644);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('symbolic links are refused when archiving', async () => {
  const dir = tree();
  try {
    symlinkSync('/etc/passwd', join(dir, 'link'));
    await assert.rejects(collectTree(dir, 'pkg'), /symbolic link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an archive with a path that escapes its destination is refused', async () => {
  const out = mkdtempSync(join(tmpdir(), 'lb-tar-out-'));
  try {
    await writeArchive([{ path: 'ok/../../evil', type: '0', data: Buffer.from('x') }], join(out, 'bad.tar.gz'));
    await assert.rejects(extractArchive(join(out, 'bad.tar.gz'), join(out, 'x')), /unsafe archive path/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a truncated archive is refused and leaves nothing behind', async () => {
  const dir = tree();
  const out = mkdtempSync(join(tmpdir(), 'lb-tar-out-'));
  try {
    await writeArchive(await collectTree(dir, 'pkg'), join(out, 'a.tar.gz'));
    const bytes = readFileSync(join(out, 'a.tar.gz'));
    writeFileSync(join(out, 'cut.tar.gz'), bytes.subarray(0, bytes.length - 40));
    await assert.rejects(extractArchive(join(out, 'cut.tar.gz'), join(out, 'x')));
    assert.throws(() => readFileSync(join(out, 'x', 'pkg', 'src', 'a.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('an archive holding a link, or too many entries, is refused', async () => {
  const dir = tree();
  const out = mkdtempSync(join(tmpdir(), 'lb-tar-out-'));
  try {
    symlinkSync('/etc/passwd', join(dir, 'link'));
    // The system tar stores the link as a link entry; ours must refuse it.
    execFileSync('tar', ['-czf', join(out, 'link.tar.gz'), '-C', dir, 'link', 'run.sh']);
    await assert.rejects(extractArchive(join(out, 'link.tar.gz'), join(out, 'x')), /refusing archive entry type/);
    await writeArchive(await collectTree(join(dir, 'src'), 'pkg'), join(out, 'many.tar.gz'));
    await assert.rejects(extractArchive(join(out, 'many.tar.gz'), join(out, 'y'), { maxEntries: 2 }), /too many entries/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
