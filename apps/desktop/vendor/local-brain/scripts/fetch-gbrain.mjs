#!/usr/bin/env node
// Fetch the pinned GBrain release binary into this package's git-ignored cache and
// verify it byte for byte against pin.json (size and SHA-256). Nothing is installed
// globally and nothing runs: the binary only lands under packages/local-brain/.cache/.
//
//   node scripts/fetch-gbrain.mjs [--platform darwin-arm64|linux-x64] [--print-path]
//
// A cached copy that still matches the pin is reused. A mismatch is deleted and refused.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPin, platformKey } from '../src/pin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

export function cachedBinaryPath(pin, platform) {
  const asset = pin.gbrain.assets[platform];
  if (!asset) throw new Error(`pin.json has no GBrain asset for ${platform}`);
  return join(packageRoot, '.cache', 'gbrain', pin.gbrain.tag, asset.name);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyBinary(path, asset) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (info.size !== asset.size) return { ok: false, reason: `size ${info.size}, pinned ${asset.size}` };
  const digest = await sha256File(path);
  if (digest !== asset.sha256) return { ok: false, reason: `sha256 ${digest}, pinned ${asset.sha256}` };
  return { ok: true, sha256: digest, size: info.size };
}

export async function fetchGbrain({ platform = platformKey(), log = console.error } = {}) {
  const pin = await readPin();
  const asset = pin.gbrain.assets[platform];
  if (!asset) throw new Error(`pin.json has no GBrain asset for ${platform}`);
  const target = cachedBinaryPath(pin, platform);
  const existing = await verifyBinary(target, asset);
  if (existing.ok) {
    log(`gbrain ${pin.gbrain.tag} (${platform}) already cached and verified: ${target}`);
    return target;
  }
  if (existing.reason !== 'missing') {
    log(`cached gbrain does not match the pin (${existing.reason}); removing it`);
    await rm(target, { force: true });
  }
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  log(`fetching ${asset.url} (${asset.size} bytes)`);
  const response = await fetch(asset.url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const out = createWriteStream(partial, { mode: 0o600 });
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      bytes += chunk.length;
      if (bytes > asset.size) throw new Error(`download exceeds the pinned size ${asset.size}`);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    await rm(partial, { force: true });
    throw error;
  }
  const digest = hash.digest('hex');
  if (bytes !== asset.size || digest !== asset.sha256) {
    await rm(partial, { force: true });
    throw new Error(`refused: got ${bytes} bytes with sha256 ${digest}; pinned ${asset.size} bytes, ${asset.sha256}`);
  }
  await chmod(partial, 0o755);
  await rename(partial, target);
  log(`verified gbrain ${pin.gbrain.tag} (${platform}): sha256 ${digest}`);
  return target;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const platformIndex = args.indexOf('--platform');
  const platform = platformIndex >= 0 ? args[platformIndex + 1] : undefined;
  fetchGbrain({ platform })
    .then((path) => {
      if (args.includes('--print-path')) process.stdout.write(`${path}\n`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
