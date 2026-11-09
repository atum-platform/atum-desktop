// A small, deterministic ustar writer and a strict reader, so the package tarball and
// the brain's backups don't depend on which `tar` a machine has. Entries are sorted,
// owned by 0:0 with empty names, stamped with one fixed time, and gzip's header is
// normalised (no name, mtime 0, OS "Unix"), so the same inputs give the same bytes on
// the same Node release. Only regular files and directories exist; the reader refuses
// links, absolute paths, `..`, duplicates and anything outside its destination.

import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, constants as zlib } from 'node:zlib';

const BLOCK = 512;
export const FIXED_MTIME = 1_704_067_200; // 2024-01-01T00:00:00Z

function octal(value, width) {
  const digits = value.toString(8);
  if (digits.length > width - 1) throw new Error(`value ${value} does not fit a ${width}-byte tar field`);
  return `${digits.padStart(width - 1, '0')}\0`;
}

function splitName(path) {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return { name: path, prefix: '' };
  for (let i = path.length - 1; i > 0; i -= 1) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) return { name, prefix };
  }
  throw new Error(`path too long for ustar: ${path}`);
}

function header({ path, mode, size, type }) {
  const block = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitName(path);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(FIXED_MTIME, 12), 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/** Normalise gzip's header: bytes 4-7 (mtime) are zero already; byte 9 is the OS. */
function gzipHeaderFix() {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      if (seen < 10) {
        const copy = Buffer.from(chunk);
        if (seen <= 9 && seen + copy.length > 9) copy[9 - seen] = 0x03;
        seen += copy.length;
        done(null, copy);
        return;
      }
      done(null, chunk);
    },
  });
}

/**
 * Collect entries from a directory tree: { path (archive path), source (file on disk),
 * mode, type }. Symlinks and special files are refused. Callers that archive private
 * state assign private modes to the complete entry list (service.mjs backupEntries).
 */
export async function collectTree(directory, archivePrefix) {
  const entries = [];
  async function walk(current) {
    const rel = relative(directory, current).split(sep).join('/');
    const archivePath = rel ? `${archivePrefix}/${rel}` : archivePrefix;
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`refusing a symbolic link: ${current}`);
    if (info.isDirectory()) {
      entries.push({ path: `${archivePath}/`, type: '5', mode: 0o755 });
      for (const name of (await readdir(current)).sort()) await walk(join(current, name));
      return;
    }
    if (!info.isFile()) throw new Error(`refusing a special file: ${current}`);
    entries.push({ path: archivePath, type: '0', mode: info.mode & 0o777, source: current, size: info.size });
  }
  await walk(directory);
  return entries;
}

/** Stream a gzip'd ustar archive of `entries` (files from `source`, or `data` buffers) into `sink`. */
export async function streamArchive(entries, sink, { level = 9 } = {}) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const names = new Set();
  for (const entry of sorted) {
    if (names.has(entry.path)) throw new Error(`duplicate archive path ${entry.path}`);
    names.add(entry.path);
  }
  async function* blocks() {
    for (const entry of sorted) {
      if (entry.type === '5') {
        yield header({ path: entry.path, mode: entry.mode ?? 0o755, size: 0, type: '5' });
        continue;
      }
      const size = entry.data ? entry.data.length : entry.size;
      yield header({ path: entry.path, mode: entry.mode ?? 0o644, size, type: '0' });
      let written = 0;
      if (entry.data) {
        yield entry.data;
        written = entry.data.length;
      } else {
        for await (const chunk of createReadStream(entry.source)) {
          written += chunk.length;
          yield chunk;
        }
      }
      if (written !== size) throw new Error(`${entry.path} changed while it was archived`);
      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      if (pad) yield Buffer.alloc(pad, 0);
    }
    yield Buffer.alloc(BLOCK * 2, 0);
  }
  await pipeline(blocks, createGzip({ level, memLevel: 9, strategy: zlib.Z_DEFAULT_STRATEGY }), gzipHeaderFix(), sink);
}

/** Write the archive to `outPath` (via a temporary name, renamed when complete). */
export async function writeArchive(entries, outPath, options) {
  const partial = `${outPath}.partial`;
  await streamArchive(entries, createWriteStream(partial, { mode: 0o600 }), options);
  await rename(partial, outPath);
}

const cString = (buffer, start, length) => {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('utf8');
};

/**
 * Extract a gzip'd ustar archive into `destination` (which must not exist). Returns the
 * list of extracted paths. Anything but plain files and directories is refused. With
 * `durable`, every file and directory is fsynced before it returns (a restore moves the
 * result into place, and must not find it empty after a power loss).
 */
export async function extractArchive(archivePath, destination, { maxBytes = 8 * 1024 * 1024 * 1024, maxEntries = 200_000, durable = false } = {}) {
  const root = resolve(destination);
  await mkdir(root, { recursive: false, mode: 0o700 });
  const extracted = [];
  const seen = new Set();
  let pending = Buffer.alloc(0);
  let current = null; // { handle, remaining, pad, target, mode }
  let total = 0;
  let ended = false;

  const finish = async () => {
    const { handle, target, mode } = current;
    current = null;
    if (durable) await handle.sync();
    await handle.close();
    await chmod(target, mode);
  };

  const safeTarget = (path) => {
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..')) {
      throw new Error(`unsafe archive path ${path}`);
    }
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`archive path escapes: ${path}`);
    return target;
  };

  let aborted = false;
  let inflight = Promise.resolve();
  const sink = new Writable({
    write(chunk, _encoding, done) {
      inflight = consume(chunk).then(() => done(), (error) => done(error));
    },
    final(done) {
      if (current || !ended) done(new Error('the archive is truncated'));
      else done();
    },
  });

  async function consume(chunk) {
    if (aborted) throw new Error('extraction aborted');
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length > 0) {
      if (ended) {
        pending = Buffer.alloc(0);
        break;
      }
      if (current) {
        const take = Math.min(current.remaining, pending.length);
        if (take > 0) {
          await current.handle.write(pending.subarray(0, take));
          current.remaining -= take;
          pending = pending.subarray(take);
        }
        if (current.remaining > 0) break;
        if (pending.length < current.pad) break;
        pending = pending.subarray(current.pad);
        await finish();
        continue;
      }
      if (pending.length < BLOCK) break;
      const block = pending.subarray(0, BLOCK);
      pending = pending.subarray(BLOCK);
      if (block.every((byte) => byte === 0)) {
        ended = true;
        continue;
      }
      if (block.subarray(257, 262).toString('ascii') !== 'ustar') throw new Error('not a ustar archive');
      const name = cString(block, 0, 100);
      const prefix = cString(block, 345, 155);
      const path = prefix ? `${prefix}/${name}` : name;
      const type = String.fromCharCode(block[156]);
      const size = parseInt(cString(block, 124, 12).trim() || '0', 8);
      const mode = parseInt(cString(block, 100, 8).trim() || '600', 8) & 0o777;
      const clean = path.replace(/\/$/, '');
      if (seen.has(clean)) throw new Error(`duplicate archive path ${clean}`);
      seen.add(clean);
      if (seen.size > maxEntries) throw new Error('archive has too many entries');
      const target = safeTarget(clean);
      if (type === '5') {
        await mkdir(target, { recursive: true, mode: 0o700 });
        extracted.push(`${clean}/`);
        continue;
      }
      if (type !== '0' && type !== '\0') throw new Error(`refusing archive entry type ${JSON.stringify(type)} for ${path}`);
      total += size;
      if (total > maxBytes) throw new Error('archive exceeds the size limit');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      current = { handle: await open(target, 'wx', 0o600), remaining: size, pad: (BLOCK - (size % BLOCK)) % BLOCK, target, mode };
      extracted.push(clean);
      if (size === 0) await finish();
    }
  }

  try {
    await pipeline(createReadStream(archivePath), createGunzip(), sink);
    if (durable) await syncDirectories(root, extracted);
  } catch (error) {
    aborted = true;
    await inflight.catch(() => {}); // let a write in progress settle before cleaning up
    await current?.handle.close().catch(() => {});
    current = null;
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return extracted;
}

/** fsync every directory the extraction created, deepest first, then the destination. */
async function syncDirectories(root, extracted) {
  const dirs = new Set();
  for (const path of extracted) {
    let dir = path.endsWith('/') ? path.slice(0, -1) : dirname(path);
    while (dir && dir !== '.' && !dirs.has(dir)) {
      dirs.add(dir);
      dir = dirname(dir);
    }
  }
  const ordered = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const dir of [...ordered.map((d) => join(root, d)), root]) {
    let handle;
    try {
      handle = await open(dir, 'r');
      await handle.sync();
    } catch {
      /* not every platform can fsync a directory */
    } finally {
      await handle?.close();
    }
  }
}
