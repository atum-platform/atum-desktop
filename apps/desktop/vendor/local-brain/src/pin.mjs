// The pinned GBrain release (pin.json). One exact tag, commit and asset digest; nothing
// floats (spec/launch-p0/v1 rule 3: "a tarball is consumed by SHA-256").

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PIN_PATH = join(packageRoot, 'pin.json');

export async function readPin(path = PIN_PATH) {
  const pin = JSON.parse(await readFile(path, 'utf8'));
  if (pin.schema !== 'atum.local-brain.pin/1') throw new Error(`unexpected pin schema ${pin.schema}`);
  if (!/^v\d+\.\d+\.\d+\.\d+$/.test(pin.gbrain.tag)) throw new Error(`GBrain tag ${pin.gbrain.tag} is not an exact release`);
  if (!/^[0-9a-f]{40}$/.test(pin.gbrain.commit)) throw new Error('GBrain commit must be a full SHA');
  for (const [platform, asset] of Object.entries(pin.gbrain.assets)) {
    if (!/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`asset ${platform} has no SHA-256`);
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error(`asset ${platform} has no size`);
    if (!asset.url.startsWith(`${pin.gbrain.upstream}/releases/download/${pin.gbrain.tag}/`)) {
      throw new Error(`asset ${platform} is not the pinned tag's release asset`);
    }
  }
  return pin;
}

export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  throw new Error(`no pinned GBrain build for ${platform}-${arch}`);
}
