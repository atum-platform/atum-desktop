import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gbrainEnvironment } from '../src/gbrain.mjs';
import { layout } from '../src/paths.mjs';
import { platformKey, readPin } from '../src/pin.mjs';
import { cachedBinaryPath } from '../scripts/fetch-gbrain.mjs';

const run = promisify(execFile);

export const pin = await readPin();
export const binary = cachedBinaryPath(pin, platformKey());
export const haveBinary = existsSync(binary);
// `pnpm test` skips the integration suite, saying so, when the binary isn't cached.
// Ready/dispatch CI fetches the pinned Linux binary and runs `test:integration`,
// which sets this and fails instead of skipping.
if (!haveBinary && process.env.LOCAL_BRAIN_REQUIRE_BINARY === '1') {
  throw new Error(`the pinned GBrain binary is not cached at ${binary}: run \`node scripts/fetch-gbrain.mjs\``);
}
export const needBinary = haveBinary ? false : 'the pinned GBrain binary is not cached: run `node scripts/fetch-gbrain.mjs` first';

export function tempRoot(prefix = 'lb-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

/**
 * Ask GBrain itself, with the service stopped: the trusted CLI opens the datastore
 * directly, so this sees what is really there, not what Atum's filters let through.
 */
export async function gbrainDirect(root, tool, args) {
  const paths = layout(root);
  // Backups intentionally omit disposable HOME/TMPDIR. Production's provision()
  // recreates them before opening the engine; this offline inspection bypasses it.
  // Bun extracts the native writer-lock addon under TMPDIR, which must exist.
  for (const dir of [paths.gbrainUserHome, paths.gbrainTmp]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    const { stdout } = await run(binary, ['call', tool, JSON.stringify(args)], {
      cwd: paths.gbrainHome,
      env: gbrainEnvironment(paths),
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, value: JSON.parse(stdout) };
  } catch (error) {
    let parsed = null;
    try {
      parsed = JSON.parse(error.stdout);
    } catch {
      parsed = null;
    }
    return { ok: false, error: parsed?.error ?? 'failed', message: parsed?.message ?? String(error.stderr ?? error.message).slice(0, 400) };
  }
}

/** Files under the datastore that still hold `needle`'s bytes (live or dead rows, WAL). */
export async function filesHolding(root, needle) {
  const paths = layout(root);
  try {
    const { stdout } = await run('grep', ['-rla', '--', needle, paths.datastore], { env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, maxBuffer: 1024 * 1024 });
    return stdout.split('\n').filter(Boolean);
  } catch (error) {
    if (error.code === 1) return []; // grep: no match
    throw error;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(check, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}
