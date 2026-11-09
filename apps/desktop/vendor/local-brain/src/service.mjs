// The local brain: one owning process per Mac account for all its agents. It holds the
// owner lock, keeps Atum's ledger, runs the pinned GBrain engine as its only child, and
// answers `atum.awareness/1` messages: envelopes, the fence notice, withdrawals,
// corrections and recall. Nothing is served until every recorded withdrawal has been
// applied to the datastore (the replay gate), so a restored or crashed brain never
// answers with something the owner already withdrew.
//
// Messages are written to GBrain in room windows (window.mjs): one page for up to 32
// messages of one scope. An accepted message is recorded in the ledger at once and its
// text staged in memory; the window is written next in line, and the receipt is answered
// only once it has been. Envelopes that arrive together (a reader that keeps several in
// flight) are written together, so one 0.3 s write carries many messages.

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { GbrainServer, GbrainToolError, provision } from './gbrain.mjs';
import { JsonRpcError, ERRORS } from './jsonrpc.mjs';
import { REPLAY_SLUG, scopeType, uuidFromHash } from './keys.mjs';
import { Ledger, isPrefixLedger } from './ledger.mjs';
import { acquireOwnerLock } from './owner-lock.mjs';
import { assertNotSynced, layout } from './paths.mjs';
import { CONTRACT_ID, LIMITS, violations } from './contract.mjs';
import { NEXT_DIR, fsyncDirectory, recoverInterrupted } from './recovery.mjs';
import {
  BrainState, WindowPlanner, audiencePlan, coverageEntry, coverageSummary, decideCorrection, decideIngest,
  decideWithdrawal, evidenceFromHits,
} from './state.mjs';
import { collectTree, extractArchive, writeArchive } from './tar.mjs';
import { parseWindow, segmentId, windowPage } from './window.mjs';

export const BACKUP_FORMAT = 'atum.local-brain.backup/1';
export const EXPORT_FORMAT = 'atum.local-brain.import/1';
const WATERMARK_EVERY = 200; // accepted messages between replay-watermark writes
export const COMPACT_AFTER_MS = 12 * 60 * 60 * 1000; // physical purge well inside the 24-hour promise
const COMPACT_CHECK_MS = 10 * 60 * 1000;

const unavailable = (message) => new JsonRpcError(ERRORS.unavailable, message);
const notFound = (error) => error instanceof GbrainToolError && /not[_ ]found|does not exist|no page/i.test(`${error.code} ${error.message}`);

export class LocalBrain {
  paths;
  state = new BrainState();
  status = 'stopped';
  timings = {};
  #binary;
  #tag;
  #forbidUnder;
  #log;
  #now;
  #lock = null;
  #ledger = null;
  #gbrain = null;
  #queue = Promise.resolve();
  #ingestsSinceWatermark = 0;
  #reported = new Map(); // sourceKey -> reader-reported coverage entry (in memory only)
  #purgeLog = []; // { seq, ref, slugs } for every record that removes text from windows
  #acceptLog = []; // { seq, objectKey } for accepted messages, for the post-restore check
  #restartTimes = []; // unexpected engine exits in the last ten minutes
  #stopping = false;
  #compactTimer = null;
  #compactAfterMs;
  #compacting = false;
  #compactThrough = null; // the running compaction's snapshot sequence
  #compactTouched = new Set(); // windows changed while a compaction copies
  // Windows (window.mjs): accepted text waiting to be written, and who waits for it.
  #planner = new WindowPlanner();
  #staged = new Map(); // window slug -> Map(objectKey -> { revision, text })
  #dirty = new Set(); // windows to write (or delete) next
  #waiters = new Map(); // window slug -> [{ resolve, reject, value }]
  #flushQueued = false;
  #writes = 0; // GBrain page writes since start
  #writeSerial = 0;

  constructor({ root, binary, tag, forbidUnder = [], log = () => {}, now = Date.now, compactAfterMs = COMPACT_AFTER_MS }) {
    this.paths = layout(root);
    this.#compactAfterMs = compactAfterMs;
    this.#binary = binary;
    this.#tag = tag;
    this.#forbidUnder = forbidUnder;
    this.#log = log;
    this.#now = now;
  }

  #fold(record) {
    const touched = this.state.apply(record);
    if (this.#compacting) for (const slug of touched) this.#compactTouched.add(slug);
    if (record.type === 'withdraw' && record.slugs.length > 0) this.#purgeLog.push({ seq: record.seq, at: record.at, ref: `withdraw:${record.withdrawalId}`, slugs: record.slugs });
    if (record.type === 'redact' && record.purge?.length > 0) this.#purgeLog.push({ seq: record.seq, at: record.at, ref: `redact:${record.objectKey}`, slugs: record.purge });
    // An edit replaces a message's text: the old text is withdrawn bytes too.
    if (record.type === 'accept' && record.object?.kind === 'edit') this.#purgeLog.push({ seq: record.seq, at: record.at, ref: `edit:${record.objectKey}`, slugs: [] });
    if (record.type === 'accept' && record.slug) this.#acceptLog.push({ seq: record.seq, objectKey: record.objectKey });
  }

  /**
   * Bytes a withdrawal, redaction or edit removed can linger in the datastore: GBrain
   * keeps each write's full request in its journal for 30 days, and PGLite never
   * vacuums, so deleted rows stay in its files. Compaction rebuilds the datastore from
   * live messages only. The debt is the oldest such record not yet compacted.
   */
  purgeDebt() {
    const owed = this.#purgeLog.filter((entry) => entry.seq > this.state.compactedThrough);
    return owed.length === 0 ? null : { records: owed.length, since: Math.min(...owed.map((entry) => entry.at)) };
  }

  #exclusive(work) {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => {});
    return run;
  }

  async start() {
    const t0 = performance.now();
    this.status = 'starting';
    assertNotSynced(this.paths.root, { forbidUnder: this.#forbidUnder });
    await mkdir(this.paths.root, { recursive: true, mode: 0o700 });
    this.#lock = acquireOwnerLock(this.paths.lockFile);
    try {
      // Before anything else: finish or roll back what a crash interrupted.
      await recoverInterrupted(this.paths, { log: this.#log });
      const t1 = performance.now();
      const steps = await provision({ binary: this.#binary, paths: this.paths, tag: this.#tag });
      if (!steps.includes('init') && !steps.includes('resume') && !existsSync(this.paths.ledgerFile)) {
        // A provisioned brain without its ledger has lost its withdrawals and the fence:
        // starting would let withdrawn or fenced content in again. Restore it instead.
        throw Object.assign(new Error('the ledger is missing: restore the brain from a backup'), { code: 'ledger_missing' });
      }
      const t2 = performance.now();
      this.#ledger = new Ledger(this.paths.ledgerFile, (record) => this.#fold(record));
      const loaded = this.#ledger.open({ now: this.#now });
      const t3 = performance.now();
      await this.#startGbrain();
      const t4 = performance.now();
      const replay = await this.#replayGate();
      const t5 = performance.now();
      this.status = 'ready';
      this.#scheduleCompaction();
      this.timings = {
        lockMs: Math.round(t1 - t0),
        provisionMs: Math.round(t2 - t1),
        provisionSteps: steps,
        ledgerMs: Math.round(t3 - t2),
        ledgerRecords: loaded.records,
        gbrainStartMs: Math.round(t4 - t3),
        replayMs: Math.round(t5 - t4),
        replay,
        totalMs: Math.round(t5 - t0),
      };
      this.#log(`ready in ${this.timings.totalMs} ms (${JSON.stringify(this.timings)})`);
      return this.timings;
    } catch (error) {
      this.status = 'error';
      await this.#gbrain?.stop().catch(() => {});
      this.#ledger?.close();
      this.#lock?.release();
      this.#lock = null;
      throw error;
    }
  }

  async #startGbrain() {
    this.#gbrain = new GbrainServer({
      binary: this.#binary,
      paths: this.paths,
      log: this.#log,
      onExit: (exit) => this.#onGbrainExit(exit),
    });
    await this.#gbrain.start();
  }

  #onGbrainExit(exit) {
    if (this.#stopping || this.status === 'maintenance') return;
    this.#log(`gbrain exited unexpectedly (${JSON.stringify(exit)})`);
    this.#scheduleRestart();
  }

  /**
   * Restart the engine after it died: at most three times in ten minutes, with backoff.
   * The replay gate runs again before anything is served. After that the service reports
   * `error` and RT's supervisor restarts the whole process.
   */
  #scheduleRestart() {
    this.status = 'degraded';
    const now = Date.now();
    this.#restartTimes = this.#restartTimes.filter((at) => now - at < 10 * 60 * 1000);
    if (this.#restartTimes.length >= 3) {
      this.status = 'error';
      this.#log('gbrain keeps exiting; giving up until the service is restarted');
      return;
    }
    this.#restartTimes.push(now);
    const delay = 500 * 2 ** (this.#restartTimes.length - 1);
    setTimeout(() => {
      this.#exclusive(async () => {
        if (this.#stopping || this.#gbrain?.running) return;
        await this.#startGbrain();
        await this.#replayGate();
        this.status = 'ready';
        this.#log('gbrain restarted; replay gate passed');
      }).catch((error) => {
        this.#log(`gbrain restart failed: ${error.message}`);
        this.#scheduleRestart();
      });
    }, delay).unref?.();
  }

  /** After a backup or a compaction stopped the engine: start it again, or recover. */
  async #resumeEngine() {
    try {
      await this.#startGbrain();
      this.status = 'ready';
    } catch (error) {
      this.#log(`gbrain did not start after maintenance: ${error.message}`);
      this.#scheduleRestart();
      throw error;
    }
  }

  #requireReady() {
    if (this.status !== 'ready' || !this.#gbrain?.running) throw unavailable(`the local brain is ${this.status}`);
  }

  /**
   * One GBrain operation. A transport failure or a stopped engine is `unavailable`
   * (retryable: the reader keeps its checkpoint); GBrain's own refusals keep their code
   * so callers can tell a missing page from an outage.
   */
  async #call(tool, args, options) {
    if (!this.#gbrain?.running) throw unavailable(`gbrain is not running (${tool})`);
    try {
      return await this.#gbrain.call(tool, args, options);
    } catch (error) {
      if (error instanceof GbrainToolError && error.code !== 'unavailable') throw error;
      throw unavailable(`gbrain ${tool} failed: ${error.message}`);
    }
  }

  #engine = (tool, args, options) => this.#call(tool, args, options);

  #requestId(kind, slug) {
    this.#writeSerial += 1;
    return uuidFromHash(`${kind}\u0000${slug}\u0000${this.#ledger.seq}\u0000${this.#writeSerial}\u0000${process.pid}\u0000${this.#now()}`);
  }

  // ------------------------------------------------------------------ windows

  /** The segments of a window as GBrain holds it now: segment ID -> text (empty if it has no page). */
  async #readWindow(slug, from = this.#engine) {
    try {
      const page = await from('get_page', { slug });
      return new Map(parseWindow(String(page?.compiled_truth ?? '')).filter((segment) => segment.complete).map((segment) => [segment.id, segment.text]));
    } catch (error) {
      if (notFound(error)) return new Map();
      throw error;
    }
  }

  async #deletePage(slug, into) {
    try {
      await into('delete_page', { slug, force: true, request_id: this.#requestId('delete', slug) });
      return true;
    } catch (error) {
      if (notFound(error)) return false;
      throw error;
    }
  }

  /**
   * Make a window's page hold exactly its live messages at their current revisions: each
   * one's text staged in memory, or its segment as GBrain holds it now (`from`); written
   * to `into` (the live engine, or a compaction's new datastore). With no one left, the
   * page is deleted. Returns { deleted, lost, written }: `lost` are live members whose
   * text neither place has (a restore or a crash lost it), left out of the page.
   */
  async #settle(slug, { into = this.#engine, from = this.#engine } = {}) {
    const window = this.state.windows.get(slug);
    const members = window
      ? [...window.members.keys()].map((key) => this.state.objects.get(key)).filter((obj) => obj?.slug === slug)
      : [];
    const staged = this.#staged.get(slug);
    let stored = null;
    const texts = new Map();
    for (const obj of members) {
      const entry = staged?.get(obj.objectKey);
      if (entry && entry.revision === obj.object.revision) {
        texts.set(obj.objectKey, entry.text);
        continue;
      }
      stored ??= await this.#readWindow(slug, from);
      const text = stored.get(segmentId(obj.objectKey, obj.object.revision));
      if (text !== undefined) texts.set(obj.objectKey, text);
    }
    const lost = members.filter((obj) => !texts.has(obj.objectKey)).map((obj) => obj.objectKey);
    const kept = members
      .filter((obj) => texts.has(obj.objectKey))
      .sort((a, b) => a.eventTime - b.eventTime || (a.objectKey < b.objectKey ? -1 : 1));
    if (kept.length === 0) {
      const deleted = await this.#deletePage(slug, into);
      return { deleted, lost, written: false };
    }
    const content = windowPage({
      slug,
      type: window.type,
      segments: kept.map((obj) => ({ id: segmentId(obj.objectKey, obj.object.revision), text: texts.get(obj.objectKey) })),
    });
    await into('put_page', { slug, content, force: true, request_id: this.#requestId('window', slug) });
    if (into === this.#engine) this.#writes += 1;
    return { deleted: false, lost, written: true };
  }

  /** Choose the window for an accepted text (the record is applied right after). */
  #place(record) {
    const { slug, vacated } = this.#planner.place(this.state, record, (this.#ledger.seq + 1).toString(36));
    if (vacated) this.#dirty.add(vacated);
    return slug;
  }

  #stage(slug, objectKey, revision, text) {
    let staged = this.#staged.get(slug);
    if (!staged) {
      staged = new Map();
      this.#staged.set(slug, staged);
    }
    staged.set(objectKey, { revision, text });
    this.#dirty.add(slug);
  }

  /** A promise for `value`, settled when the window is written. */
  #waitFor(slug, value) {
    const promise = new Promise((resolve, reject) => {
      let list = this.#waiters.get(slug);
      if (!list) {
        list = [];
        this.#waiters.set(slug, list);
      }
      list.push({ resolve, reject, value });
    });
    promise.catch(() => {}); // the caller handles it; never an unhandled rejection meanwhile
    this.#scheduleFlush();
    return promise;
  }

  /** Write every dirty window, next in line: whatever was accepted meanwhile goes too. */
  #scheduleFlush() {
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    this.#exclusive(async () => {
      this.#flushQueued = false;
      await this.#flush();
    }).catch((error) => this.#log(`writing windows failed: ${error.message}`));
  }

  /**
   * Write every dirty window (always holding the queue). A window that fails is not
   * retried here: its staged messages are recorded as lost, so the reader's retry is
   * accepted, and their callers get a retryable error. Returns the windows that failed.
   */
  async #flush() {
    const failed = new Set();
    let deleted = false;
    const windows = [...this.#dirty];
    this.#dirty.clear();
    for (const slug of windows) {
      const waiters = this.#waiters.get(slug) ?? [];
      this.#waiters.delete(slug);
      this.#planner.close(slug);
      try {
        const result = await this.#settle(slug);
        deleted ||= result.deleted;
        if (result.lost.length > 0) this.#ledger.append({ type: 'reindex', objectKeys: result.lost }, { now: this.#now });
        for (const waiter of waiters) waiter.resolve(waiter.value);
      } catch (error) {
        failed.add(slug);
        const staged = [...(this.#staged.get(slug)?.keys() ?? [])].filter((key) => this.state.objects.get(key)?.slug === slug);
        if (staged.length > 0) this.#ledger.append({ type: 'reindex', objectKeys: staged }, { now: this.#now });
        this.#log(`window ${slug} was not written: ${error.message}`);
        const failure = error instanceof JsonRpcError && error.code === ERRORS.unavailable ? error : unavailable(`the window was not written: ${error.message}`);
        for (const waiter of waiters) waiter.reject(failure);
      } finally {
        this.#staged.delete(slug);
      }
    }
    if (deleted) await this.#call('purge_deleted_pages', { older_than_hours: 0 });
    if (this.#ingestsSinceWatermark >= WATERMARK_EVERY && failed.size === 0) await this.#writeWatermark();
    return failed;
  }

  /** Rewrite the windows a withdrawal or redaction touched, then record the purge. */
  async #purgeRef(ref) {
    const slugs = this.state.pendingPurges.get(ref);
    if (!slugs || this.status !== 'ready' || !this.#gbrain?.running) return;
    for (const slug of slugs) this.#dirty.add(slug);
    const failed = await this.#flush();
    if (slugs.some((slug) => failed.has(slug))) throw unavailable(`the purge of ${ref} did not finish`);
    this.#ledger.append({ type: 'purged', ref, slugs }, { now: this.#now });
  }

  #queuePurge(ref) {
    this.#exclusive(() => this.#purgeRef(ref)).catch((error) => this.#log(`purge deferred for ${ref}: ${error.message}`));
  }

  async #readWatermark() {
    try {
      const page = await this.#call('get_page', { slug: REPLAY_SLUG });
      const match = /seq:\s*(\d+)/.exec(page?.compiled_truth ?? page?.content ?? '');
      return match ? Number(match[1]) : 0;
    } catch (error) {
      if (error instanceof GbrainToolError) return 0;
      throw error;
    }
  }

  async #writeWatermark() {
    // The watermark says every message recorded up to it is in the datastore: never
    // while any accepted text is still waiting to be written.
    if (this.#staged.size > 0) throw new Error('the replay watermark would pass text not yet written');
    const seq = this.#ledger.seq;
    await this.#call('put_page', {
      slug: REPLAY_SLUG,
      content: `---\ntitle: replay watermark\ntype: atum-sys\n---\nseq: ${seq}\n`,
      force: true,
      request_id: uuidFromHash(`watermark\u0000${seq}\u0000${this.#now()}`),
    });
    this.#ingestsSinceWatermark = 0;
    // Entries at or below the datastore's watermark are never replayed while this process
    // runs (a restore restarts the service, which reloads the whole ledger), except those
    // a running compaction still has to copy or replay into its new datastore.
    const floor = Math.min(seq, this.#compactThrough ?? Infinity);
    this.#acceptLog = this.#acceptLog.filter((entry) => entry.seq > floor);
    const keep = Math.min(floor, this.state.compactedThrough);
    this.#purgeLog = this.#purgeLog.filter((entry) => entry.seq > keep);
  }

  /**
   * Before serving: rewrite every window a withdrawal or redaction touched that the
   * datastore may not reflect (recorded after its watermark, or recorded but not yet
   * purged), then find accepted messages the datastore doesn't hold (a restore, or a
   * crash before their window was written), so the reader re-sends them instead of
   * recall silently missing them.
   */
  async #replayGate() {
    const watermark = await this.#readWatermark();
    const refs = new Map();
    for (const entry of this.#purgeLog) if (entry.seq > watermark && entry.slugs.length > 0) refs.set(entry.ref, entry.slugs);
    for (const [ref, slugs] of this.state.pendingPurges) refs.set(ref, slugs);
    const lost = new Set();
    const settled = new Set();
    let deleted = false;
    for (const slugs of refs.values()) {
      for (const slug of slugs) {
        if (settled.has(slug)) continue;
        settled.add(slug);
        const result = await this.#settle(slug);
        deleted ||= result.deleted;
        for (const key of result.lost) lost.add(key);
      }
    }
    if (deleted) await this.#call('purge_deleted_pages', { older_than_hours: 0 });
    for (const ref of refs.keys()) {
      if (this.state.pendingPurges.has(ref)) this.#ledger.append({ type: 'purged', ref, slugs: this.state.pendingPurges.get(ref) }, { now: this.#now });
    }
    const byWindow = new Map();
    for (const entry of this.#acceptLog) {
      if (entry.seq <= watermark || lost.has(entry.objectKey)) continue;
      const obj = this.state.objects.get(entry.objectKey);
      if (!obj?.slug) continue;
      if (!byWindow.has(obj.slug)) byWindow.set(obj.slug, new Set());
      byWindow.get(obj.slug).add(entry.objectKey);
    }
    const stale = new Set();
    for (const [slug, keys] of byWindow) {
      const stored = await this.#readWindow(slug);
      for (const key of keys) {
        const obj = this.state.objects.get(key);
        if (obj?.slug === slug && !stored.has(segmentId(key, obj.object.revision))) {
          lost.add(key);
          stale.add(slug);
        }
      }
    }
    if (lost.size > 0) {
      this.#ledger.append({ type: 'reindex', objectKeys: [...lost] }, { now: this.#now });
      // A window may still hold an older revision of a lost message: rewrite it without.
      let staleDeleted = false;
      for (const slug of stale) staleDeleted = (await this.#settle(slug)).deleted || staleDeleted;
      if (staleDeleted) await this.#call('purge_deleted_pages', { older_than_hours: 0 });
    }
    await this.#writeWatermark();
    return { watermark, replayedRefs: refs.size, purgedSlugs: settled.size, lostPages: lost.size };
  }

  // ------------------------------------------------------------------ the API

  /**
   * Answers the receipt once the message is in GBrain (its window written), or at once
   * when there is nothing to write. Envelopes sent without waiting for each other's
   * receipts are written together.
   */
  ingest(envelope) {
    return this.#exclusive(async () => {
      this.#requireReady();
      const decision = decideIngest(this.state, envelope, { now: this.#now() });
      if (decision.fence) this.#ledger.append({ type: 'fence', since: decision.fence.since }, { now: this.#now });
      if (decision.kind === 'invalid') {
        throw new JsonRpcError(ERRORS.invalidParams, 'not an envelope', { violations: decision.violations.slice(0, 20) });
      }
      if (decision.refused) this.state.noteRefusal(decision.refused.operationId, decision.refused.dedup);
      if (decision.kind === 'receipt') return { receipt: decision.receipt };
      if (decision.kind === 'redact') {
        // The tombstone is durable before the receipt: recall stops at once, and its
        // window is rewritten without the message next in line.
        this.#ledger.append({ ...decision.record, purge: decision.purge }, { now: this.#now });
        if (decision.purge.length > 0) this.#queuePurge(`redact:${decision.record.objectKey}`);
        return { receipt: decision.receipt };
      }
      const { record } = decision;
      if (decision.text !== null) record.slug = this.#place(record);
      this.#ledger.append(record, { now: this.#now });
      this.#ingestsSinceWatermark += 1;
      if (!record.slug) return { receipt: decision.receipt };
      this.#stage(record.slug, record.objectKey, record.object.revision, decision.text);
      return { wait: this.#waitFor(record.slug, decision.receipt) };
    }).then(({ receipt, wait }) => wait ?? receipt);
  }

  fenceNotice(notice) {
    return this.#exclusive(async () => {
      const found = violations('fence.notice', notice);
      if (found.length > 0) throw new JsonRpcError(ERRORS.invalidParams, 'not a fence notice', { violations: found });
      if (!this.state.fence.active || notice.since < this.state.fence.since) {
        this.#ledger.append({ type: 'fence', since: notice.since }, { now: this.#now });
      }
      const ack = { active: true, since: this.state.fence.since };
      const responseViolations = violations('fence.ack', ack);
      if (responseViolations.length > 0) throw new Error(`invalid fence acknowledgement: ${JSON.stringify(responseViolations)}`);
      return ack;
    });
  }

  withdraw(withdrawal) {
    return this.#exclusive(async () => {
      if (this.status !== 'ready' && this.status !== 'degraded') throw unavailable(`the local brain is ${this.status}`);
      const decision = decideWithdrawal(this.state, withdrawal, { now: this.#now() });
      if (decision.kind === 'invalid') throw new JsonRpcError(ERRORS.invalidParams, 'not a withdrawal', { violations: decision.violations });
      if (decision.kind === 'replay') return decision.receipt;
      // Recorded (and fsynced) before the receipt is returned; recall stops now,
      // because every served item is checked against this state.
      this.#ledger.append(decision.record, { now: this.#now });
      // The windows are rewritten after the answer, next in line: nothing can read the
      // withdrawn messages meanwhile. If the engine is down, the replay gate finishes it
      // before anything is served again.
      if (decision.record.slugs.length > 0) this.#queuePurge(`withdraw:${decision.record.withdrawalId}`);
      return decision.receipt;
    });
  }

  correct(correction) {
    return this.#exclusive(async () => {
      this.#requireReady();
      const decision = decideCorrection(this.state, correction);
      if (decision.kind === 'invalid') throw new JsonRpcError(ERRORS.invalidParams, 'not a correction', { violations: decision.violations });
      if (decision.kind === 'unknown_target') throw new JsonRpcError(ERRORS.invalidParams, 'the corrected evidence is not held here');
      if (decision.kind === 'replay') return { result: decision.result };
      const [statement, ...rest] = decision.records;
      statement.slug = this.#place(statement);
      this.#ledger.append(statement, { now: this.#now });
      for (const record of rest) this.#ledger.append(record, { now: this.#now });
      this.#stage(statement.slug, statement.objectKey, statement.object.revision, decision.text);
      return { wait: this.#waitFor(statement.slug, decision.result) };
    }).then(({ result, wait }) => wait ?? result);
  }

  /** Reader coverage has the frozen `coverage.report` wrapper. */
  reportCoverage(report) {
    const found = violations('coverage.report', report);
    if (found.length > 0) throw new JsonRpcError(ERRORS.invalidParams, 'not a coverage report', { violations: found });
    for (const entry of report.entries) {
      const key = [entry.source.kind, entry.source.id, entry.source.agentPrincipal ?? ''].join('\u0000');
      this.#reported.set(key, entry);
    }
    return { accepted: report.entries.length };
  }

  #coverageFor(sourceKeys) {
    const now = this.#now();
    const entries = [];
    for (const key of sourceKeys) {
      const src = this.state.sources.get(key);
      if (src) entries.push(coverageEntry(this.state, src, this.#reported.get(key), now));
      else if (this.#reported.has(key)) entries.push(this.#reported.get(key));
      if (entries.length >= LIMITS.coverage_entries) break;
    }
    return entries;
  }

  coverage() {
    const keys = new Set([...this.state.sources.keys(), ...this.#reported.keys()]);
    const entries = this.#coverageFor(keys);
    return { summary: coverageSummary(this.state, entries, this.#now()), entries };
  }

  /**
   * Recall for an audience the controller bound. A room's audience is fenced inside
   * GBrain's own query (its `types` filter), and every message is checked again against
   * the ledger before it is returned. An outage is `unavailable`, never an empty success.
   *
   * Returns exactly a contract `retrieval.response`. Private Google-derived items carry
   * `provenance.google: true`; shared and partner answers refuse those items.
   */
  async retrieve(request) {
    const found = violations('retrieval.request', request);
    if (found.length > 0) throw new JsonRpcError(ERRORS.invalidParams, 'not a retrieval request', { violations: found });
    const plan = audiencePlan(request.audience);
    const outage = (errors) => ({
        requestId: request.requestId,
        audience: request.audience,
        status: 'unavailable',
        items: [],
        coverage: [],
        contentBytes: 0,
        errors,
    });
    if (this.status !== 'ready' || !this.#gbrain?.running) return outage(['service_unavailable']);
    const fetchLimit = Math.min(100, Math.max(20, request.limits.maxItems * 5));
    let hits;
    try {
      hits = await this.#gbrain.call('search', {
        query: request.query,
        limit: fetchLimit,
        snippet_chars: LIMITS.item_content_chars,
        ...(plan.types ? { types: plan.types } : {}),
      }, { timeoutMs: 10_000 });
    } catch (error) {
      return outage([/timed out/.test(error.message) ? 'timeout' : 'index_unavailable']);
    }
    if (!Array.isArray(hits)) return outage(['index_unavailable']);
    const { items, contentBytes } = evidenceFromHits(this.state, hits, plan, request);
    const sourceKeys = new Set(items.map(({ item }) => this.state.objects.get(this.state.byEvidence.get(item.evidenceId))?.sourceKey));
    if (plan.shared) {
      for (const [key, src] of this.state.sources) if (src.source.id === plan.roomId) sourceKeys.add(key);
    } else {
      for (const key of this.state.sources.keys()) sourceKeys.add(key);
    }
    sourceKeys.delete(undefined);
    const coverage = this.#coverageFor(sourceKeys);
    const response = {
      requestId: request.requestId,
      audience: request.audience,
      status: coverage.some((entry) => entry.state !== 'ready' && entry.state !== 'excluded') ? 'degraded' : 'ok',
      items: items.map(({ item }) => item),
      coverage,
      contentBytes,
    };
    // The response is checked against the contract before it leaves: a room's answer
    // with an item from anywhere else fails its invariant, and is never sent.
    const problems = violations('retrieval.response', response);
    if (problems.length > 0) {
      this.#log(`refusing a non-conforming retrieval response: ${JSON.stringify(problems.slice(0, 5))}`);
      return outage(['index_unavailable']);
    }
    return response;
  }

  #scheduleCompaction() {
    clearInterval(this.#compactTimer);
    this.#compactTimer = setInterval(() => {
      const debt = this.purgeDebt();
      if (!debt || this.status !== 'ready' || this.#now() - debt.since < this.#compactAfterMs) return;
      this.compact().catch((error) => this.#log(`scheduled compaction failed: ${error.message}`));
    }, COMPACT_CHECK_MS);
    this.#compactTimer.unref?.();
  }

  /**
   * Rebuild the datastore from live messages only, then swap it in and delete the old
   * one whole: no withdrawn text is left in GBrain's journal, its dead rows, or its WAL.
   *
   * Online: the long copy runs beside normal work (recall, ingestion and withdrawals keep
   * using the current datastore); only the short final step holds the queue, to write
   * what was staged, copy again every window changed meanwhile, and swap. A withdrawal
   * recorded during the copy is also applied to the new datastore by the replay gate
   * right after the swap (its sequence is after the new datastore's watermark).
   *
   * A message edited, redacted or withdrawn while the copy runs may have been copied
   * before it changed: its window is copied again in the final step, but the first copy's
   * text stays in the new datastore's journal and dead rows. Its purge debt was recorded
   * after this compaction's snapshot, so it is still owed afterwards, and the next
   * compaction (12 hours after it, while the Mac is on) removes it: inside the 24 hours.
   */
  async compact() {
    if (this.#compacting) throw new JsonRpcError(ERRORS.unavailable, 'a compaction is already running');
    this.#requireReady();
    this.#compacting = true;
    this.#compactTouched = new Set();
    const began = performance.now();
    const throughSeq = this.#ledger.seq;
    this.#compactThrough = throughSeq;
    const next = layout(this.paths.root, { gbrainDir: NEXT_DIR });
    let builder = null;
    const into = (tool, args) => builder.call(tool, args);
    let copied = 0;
    const missing = new Set();
    try {
      await rm(next.gbrainHome, { recursive: true, force: true });
      await provision({ binary: this.#binary, paths: next, tag: this.#tag });
      builder = new GbrainServer({ binary: this.#binary, paths: next, log: this.#log });
      await builder.start();
      // 1. Every window as of `throughSeq`, beside normal work.
      for (const slug of [...this.state.windows.keys()]) {
        if (this.#stopping) throw new Error('the service is stopping');
        const result = await this.#settle(slug, { into });
        if (result.written) copied += 1;
        for (const key of result.lost) missing.add(key);
      }
      await builder.call('put_page', {
        slug: REPLAY_SLUG,
        content: `---\ntitle: replay watermark\ntype: atum-sys\n---\nseq: ${throughSeq}\n`,
        force: true,
        request_id: uuidFromHash(`compact-watermark\u0000${throughSeq}`),
      });
      const built = performance.now();
      // 2. Holding the queue: staged text first, then every window changed since, then the swap.
      return await this.#exclusive(async () => {
        this.#requireReady();
        await this.#flush();
        const delta = new Set(this.#compactTouched);
        for (const key of missing) {
          const obj = this.state.objects.get(key);
          if (obj?.slug) delta.add(obj.slug);
        }
        const lost = [];
        let deleted = false;
        for (const slug of delta) {
          const result = await this.#settle(slug, { into });
          deleted ||= result.deleted;
          lost.push(...result.lost);
        }
        if (deleted) await builder.call('purge_deleted_pages', { older_than_hours: 0 });
        // Messages neither datastore holds are recorded as lost, so the reader re-sends them.
        if (lost.length > 0) this.#ledger.append({ type: 'reindex', objectKeys: lost }, { now: this.#now });
        await builder.stop();
        this.status = 'maintenance';
        const retired = join(this.paths.root, `gbrain-retired-${process.pid}-${Date.now()}`);
        try {
          await this.#gbrain.stop();
          await rename(this.paths.gbrainHome, retired);
          fsyncDirectory(this.paths.root);
          try {
            await rename(next.gbrainHome, this.paths.gbrainHome);
            fsyncDirectory(this.paths.root);
          } catch (error) {
            await rename(retired, this.paths.gbrainHome); // put the old datastore back
            fsyncDirectory(this.paths.root);
            throw error;
          }
          await provision({ binary: this.#binary, paths: this.paths, tag: this.#tag }); // points GBrain at the moved datastore
          await rm(retired, { recursive: true, force: true });
        } finally {
          await this.#resumeEngine();
        }
        this.#ledger.append({ type: 'compacted', throughSeq, pages: copied }, { now: this.#now });
        // Withdrawals, redactions and edits recorded during the copy are after the new
        // datastore's watermark: the gate applies them before anything is served.
        const replay = await this.#replayGate();
        return {
          pages: copied,
          delta: delta.size,
          throughSeq,
          buildMs: Math.round(built - began),
          swapMs: Math.round(performance.now() - built),
          replay,
        };
      });
    } finally {
      this.#compacting = false;
      this.#compactThrough = null;
      this.#compactTouched = new Set();
      if (builder?.running) await builder.stop().catch(() => {});
      await rm(next.gbrainHome, { recursive: true, force: true }).catch(() => {});
    }
  }

  info() {
    let staged = 0;
    for (const entries of this.#staged.values()) staged += entries.size;
    return {
      contract: CONTRACT_ID,
      status: this.status,
      gbrain: { tag: this.#tag, pid: this.#gbrain?.pid ?? null, server: this.#gbrain?.info?.server ?? null, startMs: this.#gbrain?.startedInMs ?? null, sandboxed: this.#gbrain?.sandboxed ?? false },
      pid: process.pid,
      ledger: { seq: this.#ledger?.seq ?? 0 },
      objects: this.state.objects.size,
      sources: this.state.sources.size,
      windows: this.state.windows.size,
      writes: this.#writes,
      staged,
      withdrawals: this.state.withdrawals.size,
      pendingPurges: this.state.pendingPurges.size,
      reindexNeeded: this.state.reindexNeeded.size,
      fence: this.state.fence,
      timings: this.timings,
      purgeDebt: this.purgeDebt(),
    };
  }

  /**
   * The cloud import (G8-37·KS with G8-16): withdrawals first, then every item as a
   * valid `envelope.managed`. Nothing marked as Google-derived, and no Drive file while
   * the fence holds, ever leaves the Mac. The owner is not named: the managed service
   * takes it from its authenticated channel.
   */
  exportForCloud() {
    return this.#exclusive(async () => {
      this.#requireReady();
      await this.#flush();
      const windows = new Map();
      const textOf = async (obj) => {
        if (!windows.has(obj.slug)) windows.set(obj.slug, await this.#readWindow(obj.slug));
        return windows.get(obj.slug).get(segmentId(obj.objectKey, obj.object.revision));
      };
      const withdrawals = [];
      for (const [withdrawalId, w] of this.state.withdrawals) withdrawals.push({ withdrawalId, receipt: w.receipt });
      const scopes = [];
      for (const [, src] of this.state.sources) {
        if (src.suppressedThrough !== null || src.inclusion !== 'included') {
          scopes.push({ source: src.source, inclusion: src.inclusion, suppressedThrough: src.suppressedThrough, epoch: src.epoch });
        }
      }
      const suppressedEvidence = [...this.state.suppressedEvidence.keys()];
      const envelopes = [];
      const held = { googleDerived: 0, fencedDrive: 0, corrections: 0 };
      for (const obj of this.state.objects.values()) {
        if (!obj.slug || obj.redacted || obj.withdrawn || obj.lost) continue;
        if (obj.googleDerived) {
          held.googleDerived += 1;
          continue;
        }
        if (obj.source.kind === 'drive_file' && this.state.fence.active) {
          held.fencedDrive += 1;
          continue;
        }
        if (obj.correction) {
          held.corrections += 1; // re-sent as `correction` messages, below
          continue;
        }
        const text = await textOf(obj);
        const envelope = text === undefined ? null : {
          contract: CONTRACT_ID,
          operationId: uuidFromHash(`export\u0000${obj.objectKey}\u0000${obj.object.revision}`),
          source: obj.source,
          object: obj.object.kind === 'edit' ? { ...obj.object, replaces: obj.logicalId } : obj.object,
          author: obj.author,
          eventTime: obj.eventTime,
          observedTime: obj.observedTime,
          policy: { epoch: obj.epoch, visibility: obj.visibility, googleDerived: false, accountFence: false },
          content: { text, attachments: obj.attachments },
          digest: createHash('sha256').update(text).digest('hex'),
        };
        if (!envelope || envelope.digest !== obj.digest || violations('envelope.managed', envelope).length > 0) {
          held.unexportable = (held.unexportable ?? 0) + 1;
          continue;
        }
        envelopes.push(envelope);
      }
      const corrections = [];
      for (const [correctionId, c] of this.state.corrections) {
        const target = this.state.objects.get(c.targetKey);
        const own = this.state.objects.get(c.objectKey);
        if (!target || !own?.slug || target.googleDerived || own.googleDerived) continue;
        const statement = await textOf(own);
        if (statement === undefined) continue;
        corrections.push({
          operationId: uuidFromHash(`export-correction\u0000${correctionId}`),
          correctionId,
          target: { kind: 'evidence', evidenceId: target.evidenceId },
          statement,
          statedBy: 'owner',
          statedAt: own.eventTime,
        });
      }
      return {
        format: EXPORT_FORMAT,
        contract: CONTRACT_ID,
        exportedAt: this.#now(),
        fence: this.state.fence,
        withdrawals,
        suppressedScopes: scopes,
        suppressedEvidence,
        envelopes,
        corrections,
        held,
      };
    });
  }

  /** A consistent archive: the engine is stopped while its directory is copied. */
  backup(outPath) {
    return this.#exclusive(async () => {
      this.#requireReady();
      if (this.#compacting) throw new JsonRpcError(ERRORS.unavailable, 'a compaction is running; back up after it');
      await this.#flush();
      await this.#writeWatermark();
      this.status = 'maintenance';
      try {
        await this.#gbrain.stop();
        const manifest = { format: BACKUP_FORMAT, createdAt: this.#now(), ledgerSeq: this.#ledger.seq, gbrainTag: this.#tag };
        const entries = await backupEntries(this.paths, manifest);
        await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
        await writeArchive(entries, outPath);
        const digest = await sha256File(outPath);
        return { path: outPath, sha256: digest, bytes: (await stat(outPath)).size, ledgerSeq: manifest.ledgerSeq };
      } finally {
        await this.#resumeEngine();
      }
    });
  }

  async stop() {
    this.#stopping = true;
    clearInterval(this.#compactTimer);
    // Wait for everything queued, including work that queued more (a flush, a purge).
    for (let queue = this.#queue; ; queue = this.#queue) {
      await queue;
      if (queue === this.#queue) break;
    }
    if (this.status === 'ready') {
      try {
        await this.#flush();
        await this.#writeWatermark();
      } catch (error) {
        this.#log(`watermark not written at stop: ${error.message}`);
      }
    }
    for (const waiters of this.#waiters.values()) for (const waiter of waiters) waiter.reject(unavailable('the local brain stopped'));
    this.#waiters.clear();
    await this.#gbrain?.stop();
    this.#ledger?.close();
    this.#lock?.release();
    this.#lock = null;
    this.status = 'stopped';
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * What a backup holds: the datastore, GBrain's configuration, the provisioning marker,
 * the ledger and a manifest. Every entry is private to its owner (files 0600,
 * directories 0700), whatever its mode on disk: the archive holds message text, and a
 * restore, or the system `tar`, recreates these modes.
 */
export async function backupEntries(paths, manifest) {
  const entries = [
    ...(await collectTree(paths.datastore, 'gbrain/brain.pglite')),
    ...(await collectTree(paths.gbrainConfigDir, 'gbrain/.gbrain')),
    { path: 'gbrain/atum-provisioned.json', type: '0', source: paths.provisionedMarker, size: (await stat(paths.provisionedMarker)).size },
    { path: 'ledger/ledger.jsonl', type: '0', source: paths.ledgerFile, size: (await stat(paths.ledgerFile)).size },
    { path: 'manifest.json', type: '0', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
  ];
  return entries.map((entry) => ({ ...entry, mode: entry.type === '5' ? 0o700 : 0o600 }));
}

/** Copy a file so that it is complete on disk before its name appears. */
async function copyDurably(from, to) {
  const partial = `${to}.partial`;
  await cp(from, partial);
  const { open } = await import('node:fs/promises');
  const handle = await open(partial, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(partial, to);
  fsyncDirectory(dirname(to));
}

/**
 * Offline restore (the service must not be running: this takes the owner lock). The
 * backup's GBrain home replaces the current one; the live ledger is kept when the
 * backup's ledger is a prefix of it (the usual case: it is newer), and the backup's is
 * used only when the live one is missing. The next start's replay gate then applies
 * every withdrawal recorded after the backup before anything is served.
 *
 * Crash-safe: the backup is extracted (and fsynced) aside first; then the live home is
 * set aside and the backup's moved in, two renames. A crash between them leaves no live
 * home and one aside, which the next start (or restore) rolls back; a crash after them
 * leaves only leftovers, which are deleted (recovery.mjs). Once the restored home is in
 * place, what it replaced is deleted at once.
 */
export async function restoreBackup({ root, archive, forbidUnder = [], log = () => {} }) {
  const paths = layout(root);
  assertNotSynced(root, { forbidUnder });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = acquireOwnerLock(paths.lockFile);
  const staging = join(root, `restore-${process.pid}-${Date.now()}`);
  try {
    await recoverInterrupted(paths, { log, ambiguous: 'keep' });
    await extractArchive(archive, staging, { durable: true });
    const manifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8'));
    if (manifest.format !== BACKUP_FORMAT) throw new Error(`not a ${BACKUP_FORMAT} archive`);
    const incoming = join(staging, 'gbrain');
    for (const part of ['brain.pglite', '.gbrain', 'atum-provisioned.json']) {
      if (!existsSync(join(incoming, part))) throw new Error(`the backup has no gbrain/${part}`);
    }
    const backupLedger = await readFile(join(staging, 'ledger', 'ledger.jsonl'), 'utf8');
    let ledgerChoice = 'live';
    if (existsSync(paths.ledgerFile)) {
      const live = await readFile(paths.ledgerFile, 'utf8');
      if (!isPrefixLedger(backupLedger, live)) {
        throw Object.assign(new Error('the live ledger is not a continuation of the backup\'s: refusing to mix histories'), { code: 'ledger_diverged' });
      }
    } else {
      ledgerChoice = 'backup';
    }
    const aside = join(root, `replaced-${process.pid}-${Date.now()}`);
    const hadHome = existsSync(paths.gbrainHome);
    if (hadHome) {
      await rename(paths.gbrainHome, aside);
      fsyncDirectory(root);
    }
    try {
      await rename(incoming, paths.gbrainHome);
      fsyncDirectory(root);
    } catch (error) {
      if (hadHome) {
        await rename(aside, paths.gbrainHome);
        fsyncDirectory(root);
      }
      throw error;
    }
    if (ledgerChoice === 'backup') {
      // After the swap: a crash before this leaves a brain that refuses to start without
      // its ledger (`ledger_missing`), and the restore is run again.
      await mkdir(paths.ledgerDir, { recursive: true, mode: 0o700 });
      await copyDurably(join(staging, 'ledger', 'ledger.jsonl'), paths.ledgerFile);
    }
    // The restored home is in place: what it replaced, and anything older, goes now.
    await recoverInterrupted(paths, { log });
    return { restoredFrom: archive, backupLedgerSeq: manifest.ledgerSeq, ledger: ledgerChoice, gbrainTag: manifest.gbrainTag };
  } finally {
    await rm(staging, { recursive: true, force: true });
    lock.release();
  }
}

export { scopeType };
