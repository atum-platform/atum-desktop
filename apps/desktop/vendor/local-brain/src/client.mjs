// A reference client for the local brain's stdio API: what RT's supervisor does
// (G8-37·RT), in miniature. Spawns one service, waits for `brain.ready`, and exposes the
// methods. Used by the tests and the measurement script.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcPeer } from './jsonrpc.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

export async function startLocalBrain({ root, binary, binarySha256, forbidUnder = [], node = process.execPath, timeoutMs = 120_000, onLog } = {}) {
  const args = [cli, 'serve', '--root', root];
  if (binary) args.push('--binary', binary);
  if (binarySha256) args.push('--binary-sha256', binarySha256);
  for (const dir of forbidUnder) args.push('--forbid-under', dir);
  const began = performance.now();
  const child = spawn(node, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } });
  const logs = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    logs.push(text);
    onLog?.(text);
  });
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  exited.then((exit) => readyReject(Object.assign(new Error(`local brain exited before it was ready (${JSON.stringify(exit)}): ${logs.join('').slice(-2000)}`), { exit })));
  const peer = new JsonRpcPeer({
    input: child.stdout,
    output: child.stdin,
    onNotification: (method, params) => {
      if (method === 'brain.ready') readyResolve(params);
      if (method === 'brain.failed') readyReject(Object.assign(new Error(`${params.code}: ${params.message}`), { code: params.code }));
    },
  });
  const timer = setTimeout(() => readyReject(new Error('the local brain did not become ready in time')), timeoutMs);
  const readyInfo = await ready.finally(() => clearTimeout(timer));
  const readyMs = Math.round(performance.now() - began);
  const call = (method, params, options) => peer.request(method, params, { timeoutMs: 60_000, ...options });
  return {
    child,
    peer,
    logs,
    readyInfo,
    readyMs,
    exited,
    call,
    ingest: (envelope) => call('brain.ingest', envelope),
    fence: (notice) => call('brain.fence', notice),
    withdraw: (withdrawal) => call('brain.withdraw', withdrawal),
    correct: (correction) => call('brain.correct', correction),
    // The frozen response carries any private Google provenance on each item.
    retrieve: (request) => call('brain.retrieve', request),
    // Retained convenience alias; it returns the same frozen response.
    retrieveLocal: (request) => call('brain.retrieve', request),
    reportCoverage: (report) => call('brain.reportCoverage', report),
    coverage: () => call('brain.coverage'),
    info: () => call('brain.info'),
    exportForCloud: () => call('brain.export'),
    backup: (path) => call('brain.backup', { path }, { timeoutMs: 300_000 }),
    compact: () => call('brain.compact', undefined, { timeoutMs: 600_000 }),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return exited;
      child.stdin.end();
      const timer2 = setTimeout(() => child.kill('SIGTERM'), 20_000);
      const exit = await exited;
      clearTimeout(timer2);
      return exit;
    },
  };
}
