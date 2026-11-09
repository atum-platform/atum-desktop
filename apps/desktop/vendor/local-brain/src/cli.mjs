#!/usr/bin/env node
// The local brain's entry point. RT's supervisor (G8-37·RT) runs exactly one per Mac
// account and speaks to it over this process's stdin/stdout:
//
//   node src/cli.mjs serve   --root <dir> [--forbid-under <dir>]... [--binary <path>]
//                            [--binary-sha256 <hex>]
//   node src/cli.mjs restore --root <dir> --from <backup.tar.gz> [--forbid-under <dir>]...
//
// `serve` answers newline-delimited JSON-RPC 2.0 (methods below) and exits when its
// stdin closes, so it never outlives the app. There is no socket and no port: the only
// way to reach the brain is through the process that started it. Logs go to stderr and
// never contain message text.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcError, JsonRpcPeer, ERRORS } from './jsonrpc.mjs';
import { platformKey, readPin } from './pin.mjs';
import { LocalBrain, restoreBackup } from './service.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, forbidUnder: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = () => {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === '--root') options.root = value();
    else if (flag === '--binary') options.binary = value();
    else if (flag === '--from') options.from = value();
    else if (flag === '--forbid-under') options.forbidUnder.push(value());
    else if (flag === '--binary-sha256') options.binarySha256 = value();
    else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

/** The packaged binary (bin/gbrain in the tarball), else the development cache. */
function defaultBinary(pin) {
  const packaged = join(packageRoot, 'bin', 'gbrain');
  if (existsSync(packaged)) return packaged;
  const asset = pin.gbrain.assets[platformKey()];
  return join(packageRoot, '.cache', 'gbrain', pin.gbrain.tag, asset.name);
}

/**
 * The binary must be the pinned one, checked by its SHA-256 on every start (about 0.3 s
 * for its 139 MiB). Unsigned (development, and the package as built) it is checked
 * against the pin. Once RL signs it for the app its bytes change, so the app passes the
 * signed binary's SHA-256 from its release manifest (`--binary-sha256`) instead.
 */
async function checkBinary(binary, asset, { expectedSha256 }) {
  if (!existsSync(binary)) throw new Error(`the pinned GBrain binary is missing: ${binary}`);
  if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('--binary-sha256 needs a SHA-256 in hex');
  const expected = expectedSha256 ?? asset.sha256;
  if (expectedSha256 === undefined && statSync(binary).size !== asset.size) {
    throw new Error(`the GBrain binary is ${statSync(binary).size} bytes; the pin says ${asset.size}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  const digest = hash.digest('hex');
  if (digest !== expected) throw new Error(`the GBrain binary's SHA-256 is ${digest}; expected ${expected}`);
}

const log = (line) => process.stderr.write(`[local-brain] ${line}\n`);

async function serve(options) {
  const pin = await readPin();
  const asset = pin.gbrain.assets[platformKey()];
  const binary = options.binary ?? defaultBinary(pin);
  await checkBinary(binary, asset, { expectedSha256: options.binarySha256 });
  const brain = new LocalBrain({ root: options.root, binary, tag: pin.gbrain.tag, forbidUnder: options.forbidUnder, log });
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await brain.stop();
    } catch (error) {
      log(`stop failed: ${error.message}`);
      code = 1;
    }
    process.exit(code);
  };
  const methods = {
    'brain.info': () => brain.info(),
    'brain.ingest': (params) => brain.ingest(params),
    'brain.fence': (params) => brain.fenceNotice(params),
    'brain.withdraw': (params) => brain.withdraw(params),
    'brain.correct': (params) => brain.correct(params),
    'brain.retrieve': (params) => brain.retrieve(params),
    'brain.reportCoverage': (params) => brain.reportCoverage(params),
    'brain.coverage': () => brain.coverage(),
    'brain.export': () => brain.exportForCloud(),
    'brain.compact': () => brain.compact(),
    'brain.backup': (params) => {
      if (typeof params?.path !== 'string' || !params.path.startsWith('/')) throw new JsonRpcError(ERRORS.invalidParams, 'backup needs an absolute path');
      return brain.backup(params.path);
    },
    'brain.shutdown': () => {
      setImmediate(() => shutdown(0));
      return { stopping: true };
    },
  };
  const peer = new JsonRpcPeer({
    input: process.stdin,
    output: process.stdout,
    onRequest: async (method, params) => {
      const handler = methods[method];
      if (!handler) throw new JsonRpcError(ERRORS.methodNotFound, `unknown method ${method}`);
      return handler(params);
    },
  });
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  peer.whenClosed().then(() => shutdown(0));
  try {
    const timings = await brain.start();
    peer.notify('brain.ready', { timings, info: brain.info() });
  } catch (error) {
    log(`start failed: ${error.code ?? ''} ${error.message}`);
    peer.notify('brain.failed', { code: error.code ?? 'start_failed', message: error.message });
    process.exit(2);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.root) throw new Error('--root is required');
  if (options.command === 'serve') return serve(options);
  if (options.command === 'restore') {
    if (!options.from) throw new Error('--from is required');
    const result = await restoreBackup({ root: options.root, archive: options.from, forbidUnder: options.forbidUnder });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return undefined;
  }
  throw new Error('usage: cli.mjs serve|restore --root <dir> ...');
}

main().catch((error) => {
  log(error.message);
  process.exit(1);
});
