// The pinned GBrain engine as a child process: provisioning (init once, then fixed
// configuration) and the resident `gbrain serve` that owns the PGLite datastore, spoken
// to over MCP on its stdin/stdout.
//
// GBrain runs in its own HOME, GBRAIN_HOME and TMPDIR under the brain root, with a
// minimal environment: no provider keys, no update checks, no maintenance sweeps.
// Nothing it does reaches the person's own ~/.gbrain, ~/.claude or login items.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { JsonRpcPeer } from './jsonrpc.mjs';

const run = promisify(execFile);

export const PROTOCOL_VERSION = '2025-06-18';

/**
 * The child's whole environment. Deliberately NOT inherited from the parent: a
 * provider key, proxy or GBRAIN_* override in the app's environment must never reach it.
 */
export function gbrainEnvironment(paths) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: paths.gbrainUserHome,
    GBRAIN_HOME: paths.gbrainHome,
    TMPDIR: `${paths.gbrainTmp}/`,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    // No update check or self-upgrade marker (cli.ts maybeEmitUpdateMarker).
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SELF_UPGRADE_MODE: 'off',
    // No startup or idle maintenance sweep: link, timeline and stub extraction would
    // create derived rows outside the purge cascade this slice proves.
    GBRAIN_SWEEP: '0',
    // No content-sanity gate. It is built for scraped web pages: a chat line starting
    // "Access denied" or "verify you are human" quarantines the whole page (no chunks,
    // hidden from search), and a window page holds up to 32 messages.
    GBRAIN_NO_SANITY: '1',
    // Chunks of at most GBrain's default 2,000 tokens, whatever embedding model a future
    // configuration names: a window is sized to stay one chunk under this (window.mjs).
    GBRAIN_MAX_CHUNK_TOKENS: '2000',
  };
}

// Database-plane settings applied once per datastore.
//  - search.cache.enabled: no cached search results, so a withdrawn item can't be served
//    from a cache row written before the withdrawal.
//  - persistence.limits.*_lifetime_ids: every page write is a durable request with a
//    permanent replay ID, capped by default at 100,000 per writer for the datastore's
//    life. Compaction (a fresh datastore) resets the count; the cap is raised so a busy
//    account never stops ingesting between compactions. `--force`: the CLI doesn't list
//    these keys, but the journal reads them (persistence/limits.ts).
export const DATABASE_SETTINGS = [
  ['search.cache.enabled', 'false', false],
  ['persistence.limits.principal_lifetime_ids', '10000000', true],
  ['persistence.limits.brain_lifetime_ids', '10000000', true],
];

// On macOS the child runs under a Seatbelt profile with no IP networking and no DNS:
// GBrain has nothing to fetch in this configuration, so a faulty or compromised release
// still can't send what it indexes anywhere. Pipes and local files work as before.
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SANDBOX_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network-outbound (remote ip))',
  '(deny network-inbound (local ip))',
  '(deny network-bind (local ip))',
  '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
].join('');

export function sandboxed(binary, args) {
  if (process.platform === 'darwin' && existsSync(SANDBOX_EXEC)) {
    return { command: SANDBOX_EXEC, args: ['-p', SANDBOX_PROFILE, binary, ...args], sandboxed: true };
  }
  return { command: binary, args, sandboxed: false };
}

export class GbrainToolError extends Error {
  constructor(tool, code, message, detail) {
    super(`${tool}: ${code}: ${message}`);
    this.tool = tool;
    this.code = code;
    this.detail = detail;
  }
}

async function gbrainCli(binary, paths, args, { timeoutMs = 120_000 } = {}) {
  const invocation = sandboxed(binary, args);
  const { stdout, stderr } = await run(invocation.command, invocation.args, {
    cwd: paths.gbrainHome,
    env: gbrainEnvironment(paths),
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout, stderr };
}

function compareTags(left, right) {
  const a = left.replace(/^v/, '').split('.').map(Number);
  const b = right.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/**
 * Create the datastore once, and apply the fixed configuration. Idempotent. A newer
 * pinned GBrain applies its schema migrations (`init --migrate-only`); an older one is
 * refused, because a downgrade never runs against a newer schema.
 */
export async function provision({ binary, paths, tag }) {
  for (const dir of [paths.root, paths.gbrainHome, paths.gbrainUserHome, paths.gbrainTmp, paths.ledgerDir, paths.backups]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  let marker = null;
  if (existsSync(paths.provisionedMarker)) marker = JSON.parse(await readFile(paths.provisionedMarker, 'utf8'));
  const steps = [];
  const writeMarker = (state) => writeFile(paths.provisionedMarker, `${JSON.stringify({
    state,
    gbrainTag: tag,
    provisionedAt: marker?.provisionedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  if (!existsSync(paths.datastore)) {
    if (marker?.state === 'ready') {
      throw Object.assign(new Error('the datastore is missing but the brain was provisioned: restore it from a backup'), { code: 'datastore_missing' });
    }
    await writeMarker('initializing');
    await gbrainCli(binary, paths, ['init', '--pglite', '--no-embedding', '--non-interactive', '--db-only', '--json', '--path', paths.datastore]);
    steps.push('init');
  } else if (!marker) {
    throw Object.assign(new Error('a datastore exists that this package did not create'), { code: 'datastore_unknown' });
  } else if (marker.state === 'initializing') {
    steps.push('resume');
  } else {
    const order = compareTags(tag, marker.gbrainTag);
    if (order < 0) {
      throw Object.assign(new Error(`the datastore was last opened by GBrain ${marker.gbrainTag}; ${tag} is older`), { code: 'gbrain_downgrade' });
    }
    if (order > 0) {
      await gbrainCli(binary, paths, ['init', '--migrate-only', '--json']);
      steps.push(`migrate ${marker.gbrainTag} -> ${tag}`);
    }
  }
  // File-plane settings: nothing published or captured, no self-upgrade, and the
  // datastore where it is now (a restore or a compaction moves it).
  const config = JSON.parse(await readFile(paths.gbrainConfigFile, 'utf8'));
  config.database_path = paths.datastore;
  config.self_upgrade = { ...(config.self_upgrade ?? {}), mode: 'off', mode_prompted: true };
  config.mcp = { ...(config.mcp ?? {}), publish_skills: false };
  config.eval = { ...(config.eval ?? {}), capture: false };
  await writeFile(paths.gbrainConfigFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (steps.length > 0) {
    for (const [key, value, force] of DATABASE_SETTINGS) {
      await gbrainCli(binary, paths, ['config', 'set', key, value, ...(force ? ['--force'] : [])]);
    }
    steps.push('config');
    await writeMarker('ready');
  }
  return steps;
}

/** The resident `gbrain serve`: the only process that ever opens the datastore. */
export class GbrainServer {
  #binary;
  #paths;
  #child = null;
  #peer = null;
  #exit = null;
  #onExit;
  #log;
  info = null;
  startedInMs = null;
  sandboxed = false;

  constructor({ binary, paths, onExit = () => {}, log = () => {} }) {
    this.#binary = binary;
    this.#paths = paths;
    this.#onExit = onExit;
    this.#log = log;
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  get running() {
    return Boolean(this.#child && this.#exit === null);
  }

  async start({ timeoutMs = 60_000 } = {}) {
    const began = performance.now();
    const invocation = sandboxed(this.#binary, ['serve']);
    this.sandboxed = invocation.sandboxed;
    const child = spawn(invocation.command, invocation.args, {
      cwd: this.#paths.gbrainHome,
      env: gbrainEnvironment(this.#paths),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    this.#exit = null;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      for (const line of text.split('\n')) if (line.trim()) this.#log(`[gbrain] ${line.trim()}`);
    });
    let starting = true;
    const exited = new Promise((resolve) => {
      const done = (exit) => {
        if (this.#exit !== null) return; // 'error' and 'exit' can both fire
        this.#exit = exit;
        this.#peer?.close();
        resolve(exit);
        if (!starting) this.#onExit(exit);
      };
      child.on('exit', (code, signal) => done({ code, signal }));
      child.on('error', (error) => done({ code: null, signal: null, error: error.message }));
    });
    this.exited = exited;
    this.#peer = new JsonRpcPeer({ input: child.stdout, output: child.stdin });
    let init;
    try {
      init = await Promise.race([
        this.#peer.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'atum-local-brain', version: '0.1.0' },
        }, { timeoutMs }),
        exited.then((exit) => {
          throw new Error(`gbrain serve exited during start (${JSON.stringify(exit)})`);
        }),
      ]);
    } catch (error) {
      // A child that never answered must not keep the datastore's lock.
      if (this.#exit === null) {
        child.kill('SIGTERM');
        const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(killer);
      }
      throw error;
    } finally {
      starting = false;
    }
    this.#peer.notify('notifications/initialized', {});
    this.info = { server: init.serverInfo, protocolVersion: init.protocolVersion };
    this.startedInMs = Math.round(performance.now() - began);
    return this.info;
  }

  /** Call one GBrain operation; returns its JSON result or throws GbrainToolError. */
  async call(tool, args = {}, { timeoutMs = 30_000 } = {}) {
    if (!this.running || !this.#peer) throw new GbrainToolError(tool, 'unavailable', 'gbrain serve is not running');
    const result = await this.#peer.request('tools/call', { name: tool, arguments: args }, { timeoutMs });
    const first = result?.content?.[0]?.text ?? '';
    let parsed;
    try {
      parsed = JSON.parse(first);
    } catch {
      parsed = first;
    }
    if (result?.isError) {
      throw new GbrainToolError(tool, parsed?.error ?? 'error', parsed?.message ?? String(first).slice(0, 500), parsed);
    }
    return parsed;
  }

  async stop({ timeoutMs = 10_000 } = {}) {
    const child = this.#child;
    if (!child || this.#exit !== null) return this.#exit;
    child.stdin.end(); // gbrain serve shuts down cleanly on stdin EOF
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs * 2);
    const exit = await this.exited;
    clearTimeout(timer);
    clearTimeout(killer);
    return exit;
  }
}

export { gbrainCli, compareTags };
