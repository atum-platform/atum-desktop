#!/usr/bin/env node
// Build the local brain's package: one deterministic tarball that atum-app pins by
// SHA-256 and ships inside Atum.app (Contents/Resources/local-brain/, G8-37·RL). It holds
// the service (src/), the vendored contract, the pin, the licences, and the pinned GBrain
// binary as bin/gbrain, verified against pin.json before it is packed. There is no
// datastore in it: a brain is created at run time, outside any synced folder.
//
//   node scripts/build-tarball.mjs [--platform darwin-arm64] [--out-dir dist] [--hash-only]
//
// Prints the tarball's path and SHA-256, and writes <tarball>.sha256 beside it. The
// same inputs on the same Node release give the same bytes (see src/tar.mjs).
// `--hash-only` computes the SHA-256 and size without writing anything.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { Writable } from 'node:stream';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPin } from '../src/pin.mjs';
import { streamArchive, writeArchive } from '../src/tar.mjs';
import { cachedBinaryPath, verifyBinary } from './fetch-gbrain.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_FILES = ['package.json', 'pin.json', 'README.md'];
const PACKAGE_DIRS = ['src', 'contract', 'licenses'];

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function listFiles(dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile()) out.push(full);
    else throw new Error(`refusing ${full}: not a regular file`);
  }
  return out;
}

/** A sink that only hashes and counts: the tarball's SHA-256 and size, with nothing written. */
function hashingSink() {
  const hash = createHash('sha256');
  let bytes = 0;
  const sink = new Writable({
    write(chunk, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done();
    },
  });
  return { sink, result: () => ({ sha256: hash.digest('hex'), bytes }) };
}

export async function buildTarball({ platform = 'darwin-arm64', outDir = join(packageRoot, 'dist'), hashOnly = false } = {}) {
  const pin = await readPin();
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const asset = pin.gbrain.assets[platform];
  if (!asset) throw new Error(`pin.json has no GBrain asset for ${platform}`);
  const binary = cachedBinaryPath(pin, platform);
  const check = await verifyBinary(binary, asset);
  if (!check.ok) throw new Error(`the cached GBrain binary is not the pinned one (${check.reason}): run scripts/fetch-gbrain.mjs --platform ${platform}`);

  const prefix = `local-brain-${pkg.version}-${platform}`;
  const files = [];
  for (const name of PACKAGE_FILES) files.push({ source: join(packageRoot, name), path: name });
  for (const dir of PACKAGE_DIRS) {
    for (const full of await listFiles(join(packageRoot, dir))) {
      files.push({ source: full, path: relative(packageRoot, full).split(sep).join('/') });
    }
  }
  files.push({ source: binary, path: 'bin/gbrain', mode: 0o755 });

  const manifestFiles = {};
  const entries = [];
  const dirs = new Set();
  for (const file of files) {
    const size = statSync(file.source).size;
    manifestFiles[file.path] = { sha256: await sha256File(file.source), bytes: size };
    const mode = file.mode ?? (file.path.endsWith('cli.mjs') ? 0o755 : 0o644);
    entries.push({ path: `${prefix}/${file.path}`, type: '0', source: file.source, size, mode });
    let parent = dirname(file.path);
    while (parent !== '.' && !dirs.has(parent)) {
      dirs.add(parent);
      parent = dirname(parent);
    }
  }
  for (const dir of dirs) entries.push({ path: `${prefix}/${dir}/`, type: '5', mode: 0o755 });
  entries.push({ path: `${prefix}/`, type: '5', mode: 0o755 });
  const manifest = {
    format: 'atum.local-brain.package/1',
    name: pkg.name,
    version: pkg.version,
    platform,
    entry: 'src/cli.mjs',
    node: pkg.engines?.node ?? null,
    gbrain: { tag: pin.gbrain.tag, commit: pin.gbrain.commit, asset: asset.name, sha256: asset.sha256, bytes: asset.size },
    pglite: pin.pglite,
    contract: 'atum.awareness/1',
    files: manifestFiles,
  };
  entries.push({ path: `${prefix}/MANIFEST.json`, type: '0', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 });

  if (hashOnly) {
    const { sink, result } = hashingSink();
    await streamArchive(entries, sink);
    return { tarball: null, name: `${prefix}.tar.gz`, ...result(), files: Object.keys(manifestFiles).length };
  }
  await mkdir(outDir, { recursive: true });
  const tarball = join(outDir, `${prefix}.tar.gz`);
  await writeArchive(entries, tarball);
  const digest = await sha256File(tarball);
  await writeFile(`${tarball}.sha256`, `${digest}  ${prefix}.tar.gz\n`);
  return { tarball, name: `${prefix}.tar.gz`, sha256: digest, bytes: statSync(tarball).size, files: Object.keys(manifestFiles).length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  buildTarball({ platform: value('--platform'), outDir: value('--out-dir'), hashOnly: args.includes('--hash-only') })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
