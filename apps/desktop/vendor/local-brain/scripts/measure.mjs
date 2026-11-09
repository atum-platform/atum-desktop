#!/usr/bin/env node
// S3's local measurements (G8-40, feeding G5-13): startup, memory, disk, ingestion and
// recall latency, withdrawal and compaction, for one local brain on this Mac, with a
// synthetic corpus spread over rooms and 30 days. Keyword retrieval only (no embedding
// provider), which is what a desktop-only account has until the managed default lands.
//
//   node scripts/measure.mjs [--messages 2000] [--rooms 20] [--concurrency 1] [--out <file.json>]
//
// It creates and deletes its own temporary root; nothing else is touched.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { startLocalBrain } from '../src/client.mjs';
import { platformKey, readPin } from '../src/pin.mjs';
import { cachedBinaryPath } from './fetch-gbrain.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const MESSAGES = Number(option('--messages', '2000'));
const ROOMS = Number(option('--rooms', '20'));
const CONCURRENCY = Number(option('--concurrency', '1'));
const OUT = option('--out', null);
if (!Number.isSafeInteger(MESSAGES) || MESSAGES < 1) throw new Error('--messages must be a positive integer');
if (!Number.isSafeInteger(ROOMS) || ROOMS < 1) throw new Error('--rooms must be a positive integer');
if (!Number.isSafeInteger(CONCURRENCY) || CONCURRENCY < 1) throw new Error('--concurrency must be a positive integer');

const pin = await readPin();
const binary = cachedBinaryPath(pin, platformKey());

const rss = (pid) => {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024;
  } catch {
    return null;
  }
};
const du = (path) => {
  let total = 0;
  const walk = (p) => {
    const info = statSync(p);
    if (info.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
    else total += info.size;
  };
  try {
    walk(path);
  } catch {
    return null;
  }
  return total;
};
const mib = (bytes) => (bytes === null ? null : Math.round((bytes / 1024 / 1024) * 10) / 10);
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10 : null;
};
const sha = (text) => createHash('sha256').update(text).digest('hex');

// A deterministic corpus: short chat lines in English and Vietnamese.
let seed = 42;
const rand = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const WORDS_EN = ['launch', 'budget', 'investor', 'deck', 'trial', 'pricing', 'release', 'meeting', 'Friday', 'contract', 'design', 'review', 'Drive', 'invoice', 'hiring', 'demo', 'partner', 'roadmap', 'signup', 'support'];
const WORDS_VI = ['họp', 'ngân sách', 'nhà đầu tư', 'ra mắt', 'hợp đồng', 'thứ sáu', 'giá', 'thiết kế', 'khách hàng', 'báo cáo'];
const sentence = () => {
  const vi = rand() < 0.3;
  const words = Array.from({ length: 6 + Math.floor(rand() * 14) }, () => pick(vi ? WORDS_VI : WORDS_EN));
  return `${words.join(' ')}${rand() < 0.2 ? '?' : '.'}`;
};
const roomIds = Array.from({ length: ROOMS }, (_, i) => `!Room${String(i).padStart(3, '0')}Measure:atumplatform.com`);
const T0 = 1_790_000_000_000;
let op = 0;
const uuid = () => {
  op += 1;
  return `0f1e2d3c-4b5a-4968-8776-${op.toString(16).padStart(12, '0')}`;
};
function message(i) {
  const roomId = roomIds[i % ROOMS];
  const text = sentence();
  return {
    contract: 'atum.awareness/1',
    operationId: uuid(),
    source: { kind: 'human_group', id: roomId },
    object: { kind: 'message', id: `$m${i}Evt${sha(String(i)).slice(0, 20)}`, revision: 1 },
    author: { kind: 'human', id: `@01jperson${i % 7}xxxxxxxxxxxxxxx:atumplatform.com` },
    eventTime: T0 + Math.floor((i / MESSAGES) * 30 * 86_400_000),
    observedTime: T0 + Math.floor((i / MESSAGES) * 30 * 86_400_000) + 500,
    policy: { epoch: 1, visibility: 'shared', googleDerived: false, accountFence: false },
    content: { text, attachments: [] },
    digest: sha(text),
  };
}
const request = (audience, query) => ({
  requestId: uuid(),
  audience,
  agentPrincipal: '7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e42',
  query,
  limits: { maxItems: 8, maxContentBytes: 16_384 },
});

const root = mkdtempSync(join(tmpdir(), 'lb-measure-'));
const out = {
  asOf: new Date().toISOString(),
  machine: { platform: `${process.platform}-${process.arch}`, cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGiB: Math.round(totalmem() / 1024 ** 3) },
  node: process.version,
  gbrain: { tag: pin.gbrain.tag, commit: pin.gbrain.commit, binaryMiB: mib(statSync(binary).size) },
  corpus: { messages: MESSAGES, rooms: ROOMS, spanDays: 30, ingestConcurrency: CONCURRENCY, retrieval: 'keyword (no embedding provider)' },
};
try {
  // Cold start: a fresh root, so GBrain's init runs.
  let brain = await startLocalBrain({ root, binary });
  const info0 = await brain.info();
  out.coldStart = { readyMs: brain.readyMs, timings: brain.readyInfo.timings };
  out.idle = { serviceRssMiB: mib(rss(brain.child.pid)), gbrainRssMiB: mib(rss(info0.gbrain.pid)) };
  out.disk = { emptyDatastoreMiB: mib(du(join(root, 'gbrain', 'brain.pglite'))), emptyRootMiB: mib(du(root)) };
  await brain.stop();

  // Warm start.
  const warm = [];
  for (let i = 0; i < 3; i += 1) {
    brain = await startLocalBrain({ root, binary });
    warm.push(brain.readyMs);
    if (i < 2) await brain.stop();
  }
  out.warmStart = { readyMs: warm, gbrainServeMs: brain.readyInfo.timings.gbrainStartMs, replayMs: brain.readyInfo.timings.replayMs };

  // Ingestion.
  const ingestMs = [];
  const began = performance.now();
  let peakGbrain = 0;
  let rssSamples = 0;
  // Choose message positions rather than one sample per batch. A batch crossing multiple
  // positions still collapses them into one sample; report the count so runs with unlike
  // instrumentation are not used as strict throughput comparisons.
  const sampleIndexes = new Set([0, MESSAGES - 1]);
  for (let i = 250; i < MESSAGES; i += 250) sampleIndexes.add(i);
  for (let first = 0; first < MESSAGES; first += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, MESSAGES - first) }, (_, offset) => first + offset);
    const receipts = await Promise.all(batch.map(async (i) => {
      const t = performance.now();
      const receipt = await brain.ingest(message(i));
      ingestMs.push(performance.now() - t);
      return { i, receipt };
    }));
    for (const { i, receipt } of receipts) {
      if (receipt.state !== 'accepted') throw new Error(`message ${i}: ${JSON.stringify(receipt)}`);
    }
    if (batch.some((i) => sampleIndexes.has(i))) {
      peakGbrain = Math.max(peakGbrain, rss((await brain.info()).gbrain.pid) ?? 0);
      rssSamples += 1;
    }
  }
  const info1 = await brain.info();
  out.ingest = {
    p50Ms: pct(ingestMs, 50),
    p95Ms: pct(ingestMs, 95),
    p99Ms: pct(ingestMs, 99),
    perSecond: Math.round((MESSAGES / ((performance.now() - began) / 1000)) * 10) / 10,
    gbrainWrites: info1.writes,
    rssSamples,
    messagesPerWrite: info1.writes > 0 ? Math.round((MESSAGES / info1.writes) * 10) / 10 : null,
  };
  out.afterIngest = {
    serviceRssMiB: mib(rss(brain.child.pid)),
    gbrainRssMiB: mib(rss(info1.gbrain.pid)),
    gbrainPeakRssMiB: mib(Math.max(peakGbrain, rss(info1.gbrain.pid) ?? 0)),
    datastoreMiB: mib(du(join(root, 'gbrain', 'brain.pglite'))),
    ledgerMiB: mib(du(join(root, 'ledger'))),
  };
  out.afterIngest.datastoreKiBPerMessage = Math.round(((out.afterIngest.datastoreMiB - out.disk.emptyDatastoreMiB) * 1024 / MESSAGES) * 10) / 10;

  // Recall: private and one room's audience.
  const recall = { private: [], shared: [] };
  const queries = ['launch investor', 'budget review Friday', 'ngân sách', 'nhà đầu tư họp', 'pricing partner demo', 'contract design'];
  for (let round = 0; round < 5; round += 1) {
    for (const query of queries) {
      let t = performance.now();
      const priv = await brain.retrieve(request({ class: 'private_owner' }, query));
      recall.private.push(performance.now() - t);
      if (priv.status === 'unavailable') throw new Error('recall unavailable');
      t = performance.now();
      await brain.retrieve(request({ class: 'shared_room', roomId: roomIds[round % ROOMS] }, query));
      recall.shared.push(performance.now() - t);
    }
  }
  out.recall = {
    privateP50Ms: pct(recall.private, 50),
    privateP95Ms: pct(recall.private, 95),
    sharedP50Ms: pct(recall.shared, 50),
    sharedP95Ms: pct(recall.shared, 95),
    samples: recall.private.length,
  };

  // Withdraw a tenth of the rooms (forget), then compact.
  const withdrawMs = [];
  for (let r = 0; r < Math.max(1, Math.floor(ROOMS / 10)); r += 1) {
    const t = performance.now();
    await brain.withdraw({
      operationId: uuid(),
      withdrawalId: uuid().replace('0f1e2d3c', '0a9b8c7d'),
      scope: { kind: 'source', source: { kind: 'human_group', id: roomIds[r] } },
      reason: 'forget',
      requestedAt: Date.now(),
    });
    withdrawMs.push(performance.now() - t);
  }
  out.withdraw = { sourceWithdrawalMs: withdrawMs.map((ms) => Math.round(ms)) };
  const beforeCompact = mib(du(join(root, 'gbrain', 'brain.pglite')));
  let peakDuringCompact = 0;
  const sampler = setInterval(() => {
    try {
      const pids = execFileSync('pgrep', ['-f', 'gbrain-darwin-arm64 serve'], { encoding: 'utf8' }).split('\n').filter(Boolean);
      const total = pids.reduce((sum, pid) => sum + (rss(Number(pid)) ?? 0), 0);
      peakDuringCompact = Math.max(peakDuringCompact, total);
    } catch {
      /* none running */
    }
  }, 200);
  const compaction = await brain.compact();
  clearInterval(sampler);
  out.compaction = {
    pages: compaction.pages,
    buildMs: compaction.buildMs,
    swapMs: compaction.swapMs,
    datastoreBeforeMiB: beforeCompact,
    datastoreAfterMiB: mib(du(join(root, 'gbrain', 'brain.pglite'))),
    peakGbrainRssBothProcessesMiB: mib(peakDuringCompact),
  };
  const info2 = await brain.info();
  out.afterCompaction = { gbrainRssMiB: mib(rss(info2.gbrain.pid)), serviceRssMiB: mib(rss(brain.child.pid)) };

  // Backup size.
  const backup = await brain.backup(join(root, 'backups', 'measure.tar.gz'));
  out.backup = { archiveMiB: mib(backup.bytes) };
  await brain.stop();
  out.rootTotalMiB = mib(du(root));
} finally {
  rmSync(root, { recursive: true, force: true });
}
const text = `${JSON.stringify(out, null, 2)}\n`;
if (OUT) writeFileSync(OUT, text);
process.stdout.write(text);
