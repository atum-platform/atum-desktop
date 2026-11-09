// The local brain's policy, as pure functions over state folded from the ledger. Every
// decision here (a receipt's reason, what a withdrawal suppresses, which evidence an
// audience may see) is made without touching GBrain, so it is testable on its own and
// is the same on replay as it was live.

import { randomUUID } from 'node:crypto';
import { LIMITS, violations } from './contract.mjs';
import {
  dedupKey, evidenceIdFor, logicalObjectId, objectKey, scopeFor, scopeType, sha256Text, sourceKey, windowSlug,
} from './keys.mjs';
import {
  ESCAPE, fitsWindow, matchScore, measureSegment, oversized, parseWindow, queryTerms, segmentId, unescapeText, unmarkedText, windowMeasure,
} from './window.mjs';

export { ESCAPE, unescapeText };

export const PURGE_WITHIN_MS = LIMITS.purge_within_ms;

// Which object kinds each source can carry. Anything else is `unsupported`.
const OBJECT_KINDS = {
  assistant_chat: ['message', 'edit', 'redaction'],
  human_dm: ['message', 'edit', 'redaction'],
  human_group: ['message', 'edit', 'redaction'],
  app_exchange: ['message', 'edit', 'redaction'],
  drive_file: ['file_version', 'redaction'],
  native_memory: ['memory_revision', 'redaction'],
  owner_statement: ['message', 'edit', 'redaction'],
};

const EXCLUDING_REASONS = { exclude: 'excluded', left_room: 'left', revoked: 'excluded', account_deleted: 'excluded' };

/**
 * "Forget", "delete" and account deletion suppress for good: the objects can't be
 * learned again, and a source or account watermark holds against backfill. Excluding,
 * leaving a room and revocation are policy: the content is purged and ingestion stops,
 * and a newer policy epoch (the owner re-including, or rejoining) lets it be read again.
 * A withdrawal that names one fact or object always suppresses.
 */
export function isPermanent(scope, reason) {
  return scope.kind === 'fact' || scope.kind === 'object' || !['exclude', 'left_room', 'revoked'].includes(reason);
}

/**
 * Account deletion is `account_deleted` with the account scope, and only that; it is
 * terminal (nothing is ingested again, at any epoch). `delete` removes a message or a
 * conversation (a fact, object or source scope). For the whole account a caller means
 * either ending it (`account_deleted`) or erasing its history while it goes on
 * (`forget`), so `delete` with the account scope is refused rather than guessed, as is
 * `account_deleted` with any narrower scope. Returns the violation, or null.
 */
export function reasonScopeViolation({ scope, reason }) {
  if (reason === 'account_deleted' && scope.kind !== 'account') return ['reason_scope', '$.reason'];
  if (reason === 'delete' && scope.kind === 'account') return ['reason_scope', '$.reason'];
  return null;
}

export class BrainState {
  objects = new Map(); // objectKey -> object record (metadata only, never text)
  byEvidence = new Map(); // evidenceId -> objectKey
  windows = new Map(); // window slug -> { slug, type, members: Map(objectKey -> segment size) }
  receipts = new Map(); // dedup key -> objectKey
  receiptsByObject = new Map(); // objectKey -> Set of dedup keys
  operations = new Map(); // operationId -> dedup key it carried
  operationsByDedup = new Map(); // dedup key -> Set of operationIds
  sources = new Map(); // sourceKey -> source policy record
  suppressedObjects = new Map(); // objectKey -> suppression
  suppressedEvidence = new Map(); // evidenceId -> suppression (a fact withdrawn before it arrived here)
  accountSuppressedThrough = null; // eventTime watermark of an account-wide withdrawal
  withdrawals = new Map(); // withdrawalId -> { receipt, slugs, purged }
  corrections = new Map(); // correctionId -> { targetKey, objectKey }
  fence = { active: false, since: null };
  pendingPurges = new Map(); // ref -> slugs still to purge from GBrain
  reindexNeeded = new Set(); // objectKeys whose page a restore lost, until the reader re-sends them
  compactedThrough = 0; // ledger seq through which a compaction left no withdrawn bytes behind
  accountDeleted = false; // an account_deleted withdrawal: nothing is ever ingested again
  refusedOperations = new Map(); // operationId -> dedup key of a refused envelope (in memory, bounded)

  source(key) {
    return this.sources.get(key);
  }

  /**
   * Remember a refused envelope's operation ID, so it can't be reused for a different
   * object either. Refusals write nothing durable, so this lives in memory, bounded.
   */
  noteRefusal(operationId, dedup, limit = 10_000) {
    if (typeof operationId !== 'string' || this.operations.has(operationId) || this.refusedOperations.has(operationId)) return;
    this.refusedOperations.set(operationId, dedup);
    if (this.refusedOperations.size > limit) this.refusedOperations.delete(this.refusedOperations.keys().next().value);
  }

  #noteReceipt(dedup, key, operationId) {
    this.receipts.set(dedup, key);
    let set = this.receiptsByObject.get(key);
    if (!set) {
      set = new Set();
      this.receiptsByObject.set(key, set);
    }
    set.add(dedup);
    if (operationId) {
      this.operations.set(operationId, dedup);
      let ops = this.operationsByDedup.get(dedup);
      if (!ops) {
        ops = new Set();
        this.operationsByDedup.set(dedup, ops);
      }
      ops.add(operationId);
    }
  }

  /** Forget an object's receipts, so the reader's re-send is accepted, not a duplicate. */
  #forgetReceipts(key) {
    for (const dedup of this.receiptsByObject.get(key) ?? []) {
      this.receipts.delete(dedup);
      for (const op of this.operationsByDedup.get(dedup) ?? []) this.operations.delete(op);
      this.operationsByDedup.delete(dedup);
    }
    this.receiptsByObject.delete(key);
  }

  #sourceRecord(source) {
    const key = sourceKey(source);
    let record = this.sources.get(key);
    if (!record) {
      record = { key, source: { ...source }, epoch: 0, inclusion: 'included', suppressedThrough: null, lastEventTime: null, objects: new Set() };
      this.sources.set(key, record);
    }
    return record;
  }

  #joinWindow(slug, scope, key, size) {
    let window = this.windows.get(slug);
    if (!window) {
      window = { slug, type: scopeType(scope), members: new Map() };
      this.windows.set(slug, window);
    }
    window.members.set(key, size ?? null);
  }

  /** An object leaves its window; a window with no one left is forgotten (its page is deleted when settled). */
  #leaveWindow(slug, key, touched) {
    if (!slug) return;
    touched.push(slug);
    const window = this.windows.get(slug);
    if (!window) return;
    window.members.delete(key);
    if (window.members.size === 0) this.windows.delete(slug);
  }

  /**
   * Fold one ledger record into the state. Called on load (replay) and on append.
   * Returns the windows whose contents it changed.
   */
  apply(record) {
    const touched = [];
    switch (record.type) {
      case 'genesis':
        return touched;
      case 'accept': {
        const src = this.#sourceRecord(record.source);
        src.epoch = Math.max(src.epoch, record.epoch);
        if (record.reincluded) src.inclusion = 'included';
        src.lastEventTime = Math.max(src.lastEventTime ?? 0, record.eventTime);
        const previous = this.objects.get(record.objectKey);
        if (previous?.slug && previous.slug !== record.slug) this.#leaveWindow(previous.slug, record.objectKey, touched);
        const next = {
          objectKey: record.objectKey,
          evidenceId: record.evidenceId,
          slug: record.slug,
          scope: record.scope,
          source: record.source,
          sourceKey: src.key,
          logicalId: record.logicalId,
          object: record.object,
          firstObject: previous?.firstObject ?? record.object,
          author: record.author,
          eventTime: record.eventTime,
          observedTime: record.observedTime,
          epoch: record.epoch,
          digest: record.digest,
          visibility: record.visibility,
          googleDerived: record.googleDerived,
          attachments: record.attachments,
          size: record.size ?? null,
          redacted: false,
          supersededBy: previous?.supersededBy ?? null,
          correction: record.correction ?? null,
        };
        this.objects.set(record.objectKey, next);
        this.byEvidence.set(record.evidenceId, record.objectKey);
        if (record.slug) {
          this.#joinWindow(record.slug, record.scope, record.objectKey, record.size);
          touched.push(record.slug);
        }
        this.#noteReceipt(record.dedup, record.objectKey, record.operationId);
        src.objects.add(record.objectKey);
        this.reindexNeeded.delete(record.objectKey);
        return touched;
      }
      case 'redact': {
        const src = this.#sourceRecord(record.source);
        src.epoch = Math.max(src.epoch, record.epoch);
        const previous = this.objects.get(record.objectKey);
        if (previous?.slug) this.pendingPurges.set(`redact:${record.objectKey}`, [previous.slug]);
        this.#leaveWindow(previous?.slug, record.objectKey, touched);
        this.objects.set(record.objectKey, {
          ...(previous ?? {
            objectKey: record.objectKey, evidenceId: record.evidenceId, source: record.source, sourceKey: src.key,
            logicalId: record.logicalId, scope: scopeFor(record.source), firstObject: record.object,
          }),
          slug: null,
          object: record.object,
          redacted: true,
          googleDerived: false,
          attachments: [],
        });
        this.byEvidence.set(record.evidenceId, record.objectKey);
        this.#noteReceipt(record.dedup, record.objectKey, record.operationId);
        src.objects.add(record.objectKey);
        return touched;
      }
      case 'fence':
        if (!this.fence.active || record.since < this.fence.since) this.fence = { active: true, since: record.since };
        return touched;
      case 'withdraw': {
        const permanent = isPermanent(record.scope, record.reason);
        const suppression = { withdrawalId: record.withdrawalId, reason: record.reason, recordedAt: record.receipt.recordedAt };
        // Policy withdrawals are ordered by their source epoch, not their arrival in
        // the ledger. A withdrawal that arrived after a newer inclusion has already
        // won is still durably receipted, but it must not touch the newer source's
        // objects or queue a purge when the ledger is replayed.
        const staleSourcePolicy = record.stalePolicy === true
          || (record.scope.kind === 'source' && !permanent
            && Number.isSafeInteger(record.policyEpoch)
            && (this.sources.get(sourceKey(record.scope.source))?.epoch ?? 0) > record.policyEpoch);
        if (staleSourcePolicy) {
          this.withdrawals.set(record.withdrawalId, { receipt: record.receipt, slugs: [], purged: false, permanent });
          return touched;
        }
        record.objectKeys.forEach((key, index) => {
          const obj = this.objects.get(key);
          this.#leaveWindow(obj?.slug, key, touched);
          if (permanent) {
            this.suppressedObjects.set(key, { ...suppression, suppressionId: record.receipt.suppressionIds[index] ?? record.receipt.suppressionIds[0] });
            if (obj) this.objects.set(key, { ...obj, slug: null, withdrawn: true });
          } else if (obj) {
            this.objects.set(key, { ...obj, slug: null, excluded: true });
            this.#forgetReceipts(key);
          }
        });
        for (const evidenceId of record.evidenceIds ?? []) {
          this.suppressedEvidence.set(evidenceId, { ...suppression, suppressionId: record.receipt.suppressionIds[0] });
        }
        if (record.scope.kind === 'source') {
          const src = this.#sourceRecord(record.scope.source);
          if (Number.isSafeInteger(record.policyEpoch)) src.epoch = Math.max(src.epoch, record.policyEpoch);
          if (permanent) src.suppressedThrough = Math.max(src.suppressedThrough ?? 0, record.requestedAt);
          const inclusion = EXCLUDING_REASONS[record.reason];
          if (inclusion) src.inclusion = inclusion;
        }
        if (record.scope.kind === 'account') {
          if (record.reason === 'account_deleted') this.accountDeleted = true;
          if (permanent) this.accountSuppressedThrough = Math.max(this.accountSuppressedThrough ?? 0, record.requestedAt);
          const inclusion = EXCLUDING_REASONS[record.reason];
          if (inclusion) for (const src of this.sources.values()) src.inclusion = inclusion;
        }
        this.withdrawals.set(record.withdrawalId, { receipt: record.receipt, slugs: record.slugs, purged: false, permanent });
        if (record.slugs.length > 0) this.pendingPurges.set(`withdraw:${record.withdrawalId}`, record.slugs);
        return touched;
      }
      case 'purged':
        this.pendingPurges.delete(record.ref);
        if (record.ref.startsWith('withdraw:')) {
          const w = this.withdrawals.get(record.ref.slice('withdraw:'.length));
          if (w) w.purged = true;
        }
        return touched;
      case 'correct': {
        const target = this.objects.get(record.targetKey);
        if (target) this.objects.set(record.targetKey, { ...target, supersededBy: record.correctionId });
        this.corrections.set(record.correctionId, { targetKey: record.targetKey, objectKey: record.objectKey, operationId: record.operationId });
        return touched;
      }
      case 'compacted':
        this.compactedThrough = Math.max(this.compactedThrough, record.throughSeq);
        return touched;
      case 'reindex':
        for (const key of record.objectKeys) {
          const obj = this.objects.get(key);
          if (!obj) continue;
          this.#leaveWindow(obj.slug, key, touched);
          this.#forgetReceipts(key);
          this.objects.set(key, { ...obj, slug: null, lost: true });
          this.reindexNeeded.add(key);
        }
        return touched;
      default:
        throw new Error(`unknown ledger record ${record.type}`);
    }
  }
}

function refusal(envelope, reason) {
  return {
    kind: 'receipt',
    refused: { operationId: envelope.operationId, dedup: dedupKey(envelope.source, envelope.object) },
    receipt: { operationId: envelope.operationId, source: envelope.source, object: refOf(envelope.object), state: 'refused', reason },
  };
}

const refOf = (object) => ({ kind: object.kind, id: object.id, revision: object.revision });

function receipt(envelope, state, acceptedRevision) {
  return {
    operationId: envelope.operationId,
    source: envelope.source,
    object: refOf(envelope.object),
    state,
    acceptedRevision,
  };
}

/** True when the envelope carries the refs a receipt needs, even if it is otherwise invalid. */
function receiptable(envelope) {
  return Boolean(
    envelope && typeof envelope === 'object'
      && typeof envelope.operationId === 'string'
      && envelope.source && typeof envelope.source.kind === 'string' && typeof envelope.source.id === 'string'
      && envelope.object && typeof envelope.object.kind === 'string' && typeof envelope.object.id === 'string'
      && Number.isSafeInteger(envelope.object.revision),
  );
}

/**
 * Decide what an `envelope.local` does. Returns one of:
 *  { kind: 'receipt', receipt }                   answer without writing
 *  { kind: 'accept', record, text, receipt }      record it, then write `text` (if any) into
 *                                                 the window the service places it in
 *                                                 (`record.slug`, null until then)
 *  { kind: 'redact', record, purge, receipt }     record the tombstone, then rewrite the
 *                                                 windows in `purge` without it
 * plus `fence` when the envelope reports the account's Google fence for the first time.
 * `invalid` (not receiptable) returns { kind: 'invalid', violations }.
 */
export function decideIngest(state, envelope, { contractMessage = 'envelope.local', now = Date.now() } = {}) {
  // Any envelope from the reader that says the account is fenced sets the sticky bit,
  // even one refused for another reason: the bit only ever makes the service stricter.
  // Its time is the envelope's observation, never later than now.
  const since = Number.isSafeInteger(envelope?.observedTime) ? Math.min(envelope.observedTime, now) : now;
  const fenced = envelope?.policy?.accountFence === true
    && (!state.fence.active || since < state.fence.since);
  const fence = fenced ? { since } : null;
  const withFence = (decision) => (fence ? { ...decision, fence } : decision);
  const found = violations(contractMessage, envelope);
  if (found.length > 0) {
    if (!receiptable(envelope)) return withFence({ kind: 'invalid', violations: found });
    return withFence({ ...refusal(envelope, 'invalid'), violations: found });
  }

  const dedup = dedupKey(envelope.source, envelope.object);
  const priorDedup = state.operations.get(envelope.operationId) ?? state.refusedOperations.get(envelope.operationId);
  if (priorDedup !== undefined && priorDedup !== dedup) {
    return withFence({ ...refusal(envelope, 'invalid'), violations: [['operation_reused', '$.operationId']] });
  }
  if (state.accountDeleted) return withFence(refusal(envelope, 'withdrawn'));
  if (sha256Text(envelope.content.text) !== envelope.digest) {
    return withFence({ ...refusal(envelope, 'invalid'), violations: [['digest', '$.digest']] });
  }
  if (!OBJECT_KINDS[envelope.source.kind].includes(envelope.object.kind)) return withFence(refusal(envelope, 'unsupported'));

  const skey = sourceKey(envelope.source);
  const src = state.source(skey);
  let reincluded = false;
  if (src) {
    if (envelope.policy.epoch < src.epoch) return withFence(refusal(envelope, 'stale_policy_epoch'));
    if (src.inclusion !== 'included') {
      if (envelope.policy.epoch <= src.epoch) return withFence(refusal(envelope, 'excluded'));
      reincluded = true; // the reader only sends an included source, at a newer epoch
    }
  }
  const logicalId = logicalObjectId(envelope.object);
  const key = objectKey(envelope.source, logicalId);
  const evidenceId = evidenceIdFor(key);
  if (state.suppressedObjects.has(key) || state.suppressedEvidence.has(evidenceId)) return withFence(refusal(envelope, 'withdrawn'));
  const through = Math.max(state.accountSuppressedThrough ?? -1, src?.suppressedThrough ?? -1);
  if (envelope.eventTime <= through) return withFence(refusal(envelope, 'withdrawn'));

  const existing = state.objects.get(key);
  const held = existing && !existing.lost && !existing.excluded ? existing : undefined;
  if (held) {
    // The order: a retry of the same operation is a duplicate; anything older than what
    // is held is superseded (a redaction supersedes everything but itself); the same
    // object revision sent again under another operation is a duplicate.
    const isHeldRevision = envelope.object.id === held.object.id && envelope.object.revision === held.object.revision;
    const retry = state.operations.get(envelope.operationId) === dedup;
    if (retry || isHeldRevision) {
      return withFence({ kind: 'receipt', receipt: receipt(envelope, 'duplicate', held.object.revision) });
    }
    if (held.redacted || held.object.revision >= envelope.object.revision || state.receipts.has(dedup)) {
      return withFence({ kind: 'receipt', receipt: receipt(envelope, 'superseded', held.object.revision) });
    }
  }

  const scope = scopeFor(envelope.source);
  const base = {
    operationId: envelope.operationId,
    dedup,
    objectKey: key,
    evidenceId,
    logicalId,
    source: envelope.source,
    object: refOf(envelope.object),
    epoch: envelope.policy.epoch,
    reincluded,
  };
  if (envelope.object.kind === 'redaction') {
    const purge = existing?.slug ? [existing.slug] : [];
    return withFence({
      kind: 'redact',
      record: { type: 'redact', ...base },
      purge,
      receipt: receipt(envelope, 'accepted', envelope.object.revision),
    });
  }
  const text = envelope.content.text;
  const record = {
    type: 'accept',
    ...base,
    slug: null,
    size: text.length > 0 ? measureSegment(text) : null,
    scope,
    author: envelope.author,
    eventTime: envelope.eventTime,
    observedTime: envelope.observedTime,
    digest: envelope.digest,
    visibility: envelope.policy.visibility,
    googleDerived: envelope.policy.googleDerived === true,
    attachments: envelope.content.attachments.map((a) => ({ kind: a.kind, ref: a.ref, mime: a.mime, bytes: a.bytes, parse: a.parse })),
  };
  return withFence({
    kind: 'accept',
    record,
    text: text.length > 0 ? text : null,
    receipt: receipt(envelope, 'accepted', envelope.object.revision),
  });
}

/**
 * Chooses the window each accepted text goes into (window.mjs). A scope's new messages
 * join its open window while they fit; a window closes once it is written, and is never
 * grown again, because every rewrite puts its messages' text into GBrain's 30-day
 * journal once more. An edit stays in its window when the new text still fits there, and
 * otherwise moves to the open one, leaving its old window to be rewritten without it. A
 * message too long for any window gets one of its own.
 */
export class WindowPlanner {
  #open = new Map(); // scope type -> slug of the window being filled

  /**
   * `record` is an accept with its text's `size`, not yet applied; `newId` names a new
   * window (unique for the brain's life). Returns { slug, vacated }: the window to write
   * it into, and the window it leaves (to be rewritten without it), or null.
   */
  place(state, record, newId) {
    const size = record.size;
    const current = state.objects.get(record.objectKey);
    const held = current?.slug ? state.windows.get(current.slug) : undefined;
    if (held) {
      const sizes = [...held.members].map(([key, memberSize]) => (key === record.objectKey ? size : memberSize));
      if (sizes.every(Boolean) && fitsWindow(windowMeasure(sizes))) return { slug: current.slug, vacated: null };
    }
    const vacated = held ? current.slug : null;
    const type = scopeType(record.scope);
    if (!oversized(size)) {
      const openSlug = this.#open.get(type);
      const open = openSlug && openSlug !== vacated ? state.windows.get(openSlug) : undefined;
      const sizes = open ? [...open.members.values(), size] : null;
      if (open && sizes.every(Boolean) && fitsWindow(windowMeasure(sizes))) return { slug: openSlug, vacated };
    }
    const slug = windowSlug(record.scope, newId);
    if (!oversized(size)) this.#open.set(type, slug);
    return { slug, vacated };
  }

  /** The window was written: later messages start a new one. */
  close(slug) {
    for (const [type, open] of this.#open) if (open === slug) this.#open.delete(type);
  }

  closeAll() {
    this.#open.clear();
  }
}

/**
 * Decide what a withdrawal suppresses. Returns { kind: 'replay', receipt } for a
 * withdrawal already recorded, or { kind: 'record', record, receipt } to append before
 * answering. The receipt's `purgeBy` is at most 24 hours after it is recorded. The
 * record's `slugs` are the windows to rewrite without what it withdraws.
 */
export function decideWithdrawal(state, withdrawal, { now = Date.now() } = {}) {
  const found = violations('withdrawal', withdrawal);
  if (found.length > 0) return { kind: 'invalid', violations: found };
  const pairing = reasonScopeViolation(withdrawal);
  if (pairing) return { kind: 'invalid', violations: [pairing] };
  const prior = state.withdrawals.get(withdrawal.withdrawalId);
  if (prior) return { kind: 'replay', receipt: prior.receipt };

  const scope = withdrawal.scope;
  const staleSourcePolicy = scope.kind === 'source' && !isPermanent(scope, withdrawal.reason)
    && withdrawal.policyEpoch < (state.source(sourceKey(scope.source))?.epoch ?? 0);
  let objectKeys = [];
  const evidenceIds = [];
  if (staleSourcePolicy) {
    // Keep a durable, idempotent receipt for the reader, while preserving the
    // current source epoch and every object admitted under it.
  } else if (scope.kind === 'fact') {
    const key = state.byEvidence.get(scope.evidenceId);
    if (key) objectKeys = [key];
    else evidenceIds.push(scope.evidenceId);
  } else if (scope.kind === 'object') {
    const skey = sourceKey(scope.source);
    const match = [...(state.sources.get(skey)?.objects ?? [])].find((key) => {
      const obj = state.objects.get(key);
      return obj && (obj.logicalId === scope.objectId || obj.object?.id === scope.objectId || obj.firstObject?.id === scope.objectId);
    });
    objectKeys = [match ?? objectKey(scope.source, scope.objectId)];
  } else if (scope.kind === 'source') {
    objectKeys = [...(state.sources.get(sourceKey(scope.source))?.objects ?? [])];
  } else {
    objectKeys = [...state.objects.keys()];
  }
  objectKeys = objectKeys.filter((key) => !state.suppressedObjects.has(key) || scope.kind === 'fact' || scope.kind === 'object');
  const perObject = scope.kind === 'fact' || scope.kind === 'object';
  const suppressionIds = perObject ? objectKeys.map(() => randomUUID()) : [randomUUID()];
  if (suppressionIds.length === 0) suppressionIds.push(randomUUID());
  const slugs = [...new Set(objectKeys.map((key) => state.objects.get(key)?.slug).filter(Boolean))];
  const receipt = {
    withdrawalId: withdrawal.withdrawalId,
    state: 'recorded',
    recordedAt: now,
    purgeBy: now + PURGE_WITHIN_MS,
    suppressionIds,
  };
  return {
    kind: 'record',
    record: {
      type: 'withdraw',
      withdrawalId: withdrawal.withdrawalId,
      operationId: withdrawal.operationId,
      scope,
      reason: withdrawal.reason,
      requestedAt: withdrawal.requestedAt,
      policyEpoch: withdrawal.policyEpoch,
      objectKeys,
      evidenceIds,
      slugs,
      stalePolicy: staleSourcePolicy,
      receipt,
    },
    receipt,
  };
}

/**
 * A correction supersedes the fact it names; the owner's statement becomes private
 * evidence citing the original. Returns { kind: 'record', records, text, result }: the
 * statement's accept record (placed in a window by the service) and the `correct` record.
 */
export function decideCorrection(state, correction) {
  const found = violations('correction', correction);
  if (found.length > 0) return { kind: 'invalid', violations: found };
  const prior = state.corrections.get(correction.correctionId);
  if (prior) {
    const obj = state.objects.get(prior.objectKey);
    return { kind: 'replay', result: { correctionId: correction.correctionId, state: 'recorded', evidenceId: obj?.evidenceId ?? null } };
  }
  let targetKey;
  if (correction.target.kind === 'evidence') targetKey = state.byEvidence.get(correction.target.evidenceId);
  else {
    const skey = sourceKey(correction.target.source);
    targetKey = [...(state.sources.get(skey)?.objects ?? [])].find((key) => {
      const obj = state.objects.get(key);
      return obj && (obj.logicalId === correction.target.objectId || obj.object?.id === correction.target.objectId);
    });
  }
  const target = targetKey ? state.objects.get(targetKey) : undefined;
  if (!target || target.withdrawn || target.redacted || target.excluded || target.lost) return { kind: 'unknown_target' };
  const source = { kind: 'owner_statement', id: 'corrections' };
  const key = objectKey(source, correction.correctionId);
  const evidenceId = evidenceIdFor(key);
  const scope = { kind: 'private' };
  const object = { kind: 'message', id: correction.correctionId, revision: 1 };
  return {
    kind: 'record',
    records: [
      {
        type: 'accept',
        operationId: correction.operationId,
        dedup: dedupKey(source, object),
        objectKey: key,
        evidenceId,
        logicalId: correction.correctionId,
        source,
        object,
        epoch: 1,
        reincluded: false,
        slug: null,
        size: measureSegment(correction.statement),
        scope,
        author: { kind: 'owner', id: 'owner' },
        eventTime: correction.statedAt,
        observedTime: correction.statedAt,
        digest: sha256Text(correction.statement),
        googleDerived: target.googleDerived === true,
        attachments: [],
        correction: {
          correctionId: correction.correctionId,
          targetKey,
          targetEvidenceId: target.evidenceId,
          targetObject: target.object,
          statementRef: correction.statementRef ?? null,
        },
      },
      { type: 'correct', correctionId: correction.correctionId, operationId: correction.operationId, targetKey, objectKey: key },
    ],
    text: correction.statement,
    result: { correctionId: correction.correctionId, state: 'recorded', evidenceId },
  };
}

// -------------------------------------------------------------------------- retrieval

const CONTENT_MAX = LIMITS.item_content_chars;

function citationFor(state, obj) {
  if (obj.correction) {
    if (obj.correction.statementRef) {
      const citation = citationFor(state, obj.correction.statementRef);
      if (citation) return citation;
    }
    // Older corrections did not carry the owner's statement event, so retain the
    // corrected fact as their citation fallback.
    const target = state.objects.get(obj.correction.targetKey);
    return target && !target.correction ? citationFor(state, target) : null;
  }
  const { source, object } = obj;
  if (source.kind === 'drive_file') return { kind: 'drive_file', fileId: obj.logicalId, version: String(object.revision) };
  if (source.kind === 'native_memory' && source.agentPrincipal) {
    return { kind: 'memory', agentPrincipal: source.agentPrincipal, revision: object.revision };
  }
  if (/^![!-~]+$/.test(source.id) && /^[$][!-~]+$/.test(object.id)) {
    return { kind: 'matrix_event', roomId: source.id, eventId: object.id };
  }
  return null;
}

function epistemicFor(obj, text) {
  if (obj.correction) return 'correction';
  if (/[?？]\s*$/.test(text)) return 'question';
  return 'unknown';
}

/**
 * Which evidence an audience may see, decided on Atum's side before anything is read:
 * a room's audience only ever sees pages of its own room's scope type (passed to GBrain
 * as its `types` filter), and nothing marked as derived from Google data.
 */
export function audiencePlan(audience) {
  if (audience.class === 'shared_room' || audience.class === 'partner') {
    return { types: [scopeType({ kind: 'room', roomId: audience.roomId })], roomId: audience.roomId, shared: true };
  }
  return { types: null, roomId: null, shared: false };
}

/** Is this object still servable evidence for this audience? */
export function servable(state, obj, plan, { filters } = {}) {
  if (!obj || obj.redacted || obj.withdrawn || obj.excluded || obj.lost || !obj.slug) return false;
  if (state.suppressedObjects.has(obj.objectKey) || state.suppressedEvidence.has(obj.evidenceId)) return false;
  if (obj.supersededBy) return false;
  const src = state.sources.get(obj.sourceKey);
  if (src && src.inclusion !== 'included') return false;
  const through = Math.max(state.accountSuppressedThrough ?? -1, src?.suppressedThrough ?? -1);
  if (obj.eventTime <= through) return false;
  if (plan.shared) {
    if (obj.scope.kind !== 'room' || obj.scope.roomId !== plan.roomId) return false;
    if (obj.googleDerived) return false;
    if (obj.correction) return false;
  }
  if (filters?.sourceKinds && !filters.sourceKinds.includes(obj.source.kind)) return false;
  if (filters?.since !== undefined && obj.eventTime < filters.since) return false;
  if (filters?.until !== undefined && obj.eventTime > filters.until) return false;
  return true;
}

/**
 * The messages one search hit holds, as { obj, content }. A hit is a window's chunk: each
 * marker in it names an object and revision, and only a marker naming an object's
 * current revision in this window counts; stale segments (an older revision, or an
 * object since moved, withdrawn or redacted) are passed over. A chunk with no marker
 * counts only for a window made for one long message, which may span several chunks.
 */
export function windowMessages(state, hit) {
  const window = state.windows.get(hit.slug);
  if (!window) return { found: [], segments: 0 };
  const byMarker = new Map();
  for (const key of window.members.keys()) {
    const obj = state.objects.get(key);
    if (obj?.slug === hit.slug) byMarker.set(segmentId(key, obj.object.revision), obj);
  }
  const text = String(hit.chunk_text ?? '');
  const segments = parseWindow(text);
  const found = [];
  for (const segment of segments) {
    const obj = byMarker.get(segment.id);
    if (obj) found.push({ obj, content: segment.text });
  }
  if (segments.length === 0 && byMarker.size === 1) {
    const [only] = byMarker.values();
    if (only.size && oversized(only.size)) found.push({ obj: only, content: unmarkedText(text) });
  }
  return { found, segments: Math.max(segments.length, found.length) };
}

/**
 * Turn GBrain search hits into contract evidence items, within the request's limits.
 * GBrain ranks windows; within a window with several messages, only those that share a
 * word with the question are evidence (a window holding one message is GBrain's match
 * itself). Items are ordered by how many of the question's words they have, then by
 * GBrain's rank of their window, then newest first.
 */
export function evidenceFromHits(state, hits, plan, request) {
  const maxItems = Math.min(request.limits.maxItems, LIMITS.recall_items);
  const maxBytes = Math.min(request.limits.maxContentBytes, LIMITS.recall_content_bytes);
  const terms = queryTerms(request.query);
  const candidates = [];
  const considered = new Set();
  hits.forEach((hit, rank) => {
    const { found, segments } = windowMessages(state, hit);
    for (const { obj, content } of found) {
      if (considered.has(obj.objectKey)) continue;
      considered.add(obj.objectKey);
      if (!servable(state, obj, plan, { filters: request.filters })) continue;
      const score = matchScore(terms, content);
      if (score === 0 && segments > 1) continue; // another message in this window matched, not this one
      candidates.push({ obj, content, score, rank });
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.rank - b.rank || b.obj.eventTime - a.obj.eventTime);
  const items = [];
  let contentBytes = 0;
  for (const { obj, content: text } of candidates) {
    if (items.length >= maxItems) break;
    const citation = citationFor(state, obj);
    if (!citation) continue;
    let content = text;
    if ([...content].length > CONTENT_MAX) content = [...content].slice(0, CONTENT_MAX).join('');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes + bytes > maxBytes) break;
    contentBytes += bytes;
    const item = {
      evidenceId: obj.evidenceId,
      source: obj.source,
      object: obj.object,
      author: obj.author,
      eventTime: obj.eventTime,
      observedTime: obj.observedTime,
      policyEpoch: obj.epoch,
      scope: obj.scope,
      epistemic: epistemicFor(obj, content),
      derivation: {
        parents: obj.correction ? [obj.correction.targetEvidenceId] : [],
        sourceRefs: obj.firstObject && obj.firstObject.id !== obj.object.id ? [obj.firstObject] : [],
      },
      digest: obj.digest,
      citation,
      content,
      untrustedInput: true,
      ...(obj.googleDerived && !plan.shared ? { provenance: { google: true } } : {}),
    };
    items.push({ item, googleDerived: obj.googleDerived === true });
  }
  return { items, contentBytes };
}

// -------------------------------------------------------------------------- coverage

const SEVERITY = { ready: 0, excluded: 1, catching_up: 2, partial: 3, paused: 4, offline: 5, needs_keys: 6, error: 7 };

/** The service's own view of one source, merged with what the reader last reported. */
export function coverageEntry(state, src, reported, now) {
  const reasons = new Set();
  let status = 'ready';
  const worse = (candidate) => {
    if (SEVERITY[candidate] > SEVERITY[status]) status = candidate;
  };
  if (src.inclusion !== 'included') {
    status = 'excluded';
    reasons.add('excluded_by_owner');
  } else {
    const lost = [...src.objects].some((key) => state.reindexNeeded.has(key));
    if (lost) {
      worse('catching_up');
      reasons.add('backfill_pending');
    }
    const unsupported = [...src.objects].some((key) => state.objects.get(key)?.attachments?.some((a) => a.parse !== 'parsed'));
    if (unsupported) {
      worse('partial');
      reasons.add('unsupported_media');
    }
    if (reported && reported.state !== 'ready') {
      worse(reported.state);
      for (const reason of reported.reasons) reasons.add(reason);
    }
  }
  const entry = { source: src.source, state: status, reasons: status === 'ready' ? [] : [...reasons].sort(), asOf: now };
  if (status !== 'ready' && entry.reasons.length === 0) entry.reasons = ['service_unavailable'];
  // processedThrough is how far this brain holds the source without a gap. After a
  // restore lost pages, it drops to just before the oldest lost one: a reader whose
  // checkpoint is later rewinds to it and re-sends.
  const lostTimes = [...src.objects].filter((key) => state.reindexNeeded.has(key)).map((key) => state.objects.get(key)?.eventTime).filter(Number.isSafeInteger);
  if (lostTimes.length > 0) entry.processedThrough = Math.max(0, Math.min(...lostTimes) - 1);
  else if (src.lastEventTime !== null) entry.processedThrough = src.lastEventTime;
  if (reported?.backfill) entry.backfill = reported.backfill;
  return entry;
}

export function coverageSummary(state, entries, now) {
  const counts = Object.fromEntries(Object.keys(SEVERITY).map((key) => [key, 0]));
  let worst = null;
  for (const entry of entries) {
    counts[entry.state] += 1;
    if (entry.state === 'excluded') continue;
    if (worst === null || SEVERITY[entry.state] > SEVERITY[worst]) worst = entry.state;
  }
  const paused = entries.filter((entry) => entry.reasons.includes('google_fence')).length;
  return {
    asOf: now,
    state: worst ?? (entries.length > 0 ? 'excluded' : 'ready'),
    counts,
    googleFence: { active: state.fence.active, pausedSources: paused },
  };
}
