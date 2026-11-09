// The local brain's decisions, without GBrain: every receipt reason, what a withdrawal
// suppresses, and what an audience may see.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { violations } from '../src/contract.mjs';
import { evidenceIdFor, objectKey, scopeType } from '../src/keys.mjs';
import { BrainState, WindowPlanner, audiencePlan, decideCorrection, decideIngest, decideWithdrawal, evidenceFromHits, servable } from '../src/state.mjs';
import { ESCAPE, MARK, escapeText, parseWindow, segmentId, unescapeText, windowPage } from '../src/window.mjs';
import { ROOMS, contractFixture, corpus, envelope, retrievalRequest, withdrawal } from './fixtures/corpus.mjs';

let seq = 0;
function fold(state, record) {
  seq += 1;
  state.apply({ seq, at: 1_790_700_000_000 + seq, ...record });
}

function ingest(state, env) {
  const decision = decideIngest(state, env);
  if (decision.fence) fold(state, { type: 'fence', since: decision.fence.since });
  if (decision.kind === 'accept') {
    if (decision.text !== null) decision.record.slug = new WindowPlanner().place(state, decision.record, seq + 1).slug;
    fold(state, decision.record);
  }
  if (decision.kind === 'redact') fold(state, { ...decision.record, purge: decision.purge });
  return decision;
}

const receiptOf = (decision) => decision.receipt;

test('an accepted envelope is placed in a window fenced to its room', () => {
  const state = new BrainState();
  const d = ingest(state, corpus().launchMessage);
  assert.equal(d.kind, 'accept');
  assert.deepEqual(violations('ingestion.receipt', d.receipt), []);
  assert.equal(state.windows.get(d.record.slug).type, scopeType({ kind: 'room', roomId: ROOMS.launch }));
  assert.match(d.record.slug, /^atum\/r-[0-9a-f]{24}\/w-\d+$/);
  assert.equal(d.record.scope.roomId, ROOMS.launch);
});

test('receipts: a retry is a duplicate, anything older superseded, one evidence ID everywhere', () => {
  const state = new BrainState();
  const data = corpus();
  ingest(state, data.launchMessage);
  ingest(state, data.launchEdit);
  assert.equal(receiptOf(ingest(state, data.launchEdit)).state, 'duplicate', 'a retry of the same operation');
  const secondDevice = receiptOf(ingest(state, { ...data.launchEdit, operationId: '00000000-0000-4000-8000-68bfdaebe3e9' }));
  assert.equal(secondDevice.state, 'duplicate', 'the held revision from a second device');
  assert.equal(receiptOf(ingest(state, data.launchMessage)).state, 'duplicate', 'a retry, even after an edit');
  const late = receiptOf(ingest(state, { ...data.launchMessage, operationId: '00000000-0000-4000-8000-ca92aa899079' }));
  assert.equal(late.state, 'superseded', 'an older revision from another device');
  assert.equal(late.acceptedRevision, 2);
  const older = { ...data.launchEdit, operationId: '00000000-0000-4000-8000-d2b714bf2644', object: { ...data.launchEdit.object, id: '$olderEditEvt', revision: 1 } };
  const superseded = receiptOf(ingest(state, older));
  assert.equal(superseded.state, 'superseded');
  assert.equal(superseded.acceptedRevision, 2);
  const key = objectKey(data.launchMessage.source, data.launchMessage.object.id);
  assert.equal(state.objects.get(key).evidenceId, evidenceIdFor(key));
});

test('refusals name the reason: invalid, digest, unsupported, reused operation', () => {
  const state = new BrainState();
  const data = corpus();
  assert.equal(decideIngest(state, contractFixture('envelope-names-owner.managed')).receipt.reason, 'invalid');
  assert.equal(decideIngest(state, contractFixture('envelope-redaction-with-content.managed')).receipt.reason, 'invalid');
  const badDigest = { ...data.anDecision, digest: '0'.repeat(64) };
  assert.equal(decideIngest(state, badDigest).receipt.reason, 'invalid');
  const wrongKind = { ...data.anDecision, object: { kind: 'file_version', id: 'x', revision: 1 } };
  assert.equal(decideIngest(state, wrongKind).receipt.reason, 'unsupported');
  ingest(state, data.anDecision);
  const reused = { ...data.anOlder, operationId: data.anDecision.operationId };
  assert.equal(decideIngest(state, reused).receipt.reason, 'invalid');
  assert.equal(decideIngest(state, { nonsense: true }).kind, 'invalid');
});

test('the local brain accepts what only envelope.local allows, and records the fence', () => {
  const state = new BrainState();
  const d = ingest(state, contractFixture('envelope-local-google-derived.local'));
  assert.equal(d.kind, 'accept');
  assert.equal(d.record.googleDerived, true);
  assert.deepEqual(state.fence, { active: true, since: 1_790_578_801_500 });
  const fenced = contractFixture('envelope-drive-file-fenced-account.managed');
  assert.equal(ingest(state, fenced).kind, 'accept', 'a fenced Drive file may be indexed on this Mac');
});

test('a refused envelope\'s operation ID can\'t be reused for another object', () => {
  const state = new BrainState();
  const data = corpus();
  const bad = { ...data.anDecision, digest: '0'.repeat(64) };
  const first = decideIngest(state, bad);
  assert.equal(first.receipt.reason, 'invalid');
  state.noteRefusal(first.refused.operationId, first.refused.dedup);
  const reused = { ...data.anOlder, operationId: bad.operationId };
  assert.equal(decideIngest(state, reused).receipt.reason, 'invalid');
  assert.equal(decideIngest(state, { ...data.anDecision, operationId: bad.operationId }).kind, 'accept', 'the same object, fixed, is fine');
});

test('account deletion is terminal: nothing is ingested again, at any epoch', () => {
  const state = new BrainState();
  const data = corpus();
  ingest(state, data.anDecision);
  fold(state, decideWithdrawal(state, withdrawal({ kind: 'account' }, 'account_deleted', 1_790_700_000_000), { now: 1_790_700_000_100 }).record);
  const later = envelope({ kind: 'human_dm', id: ROOMS.an, object: { kind: 'message', id: '$afterDeletion', revision: 1 }, author: data.anDecision.author, eventTime: 1_790_800_000_000, text: 'after', epoch: 9 });
  assert.equal(decideIngest(state, later).receipt.reason, 'withdrawn');
});

test('the fence\'s time is never later than now', () => {
  const state = new BrainState();
  const future = { ...contractFixture('envelope-local-google-derived.local'), observedTime: 9_000_000_000_000 };
  const d = decideIngest(state, future, { now: 1_790_700_000_000 });
  assert.equal(d.fence.since, 1_790_700_000_000);
});

test('the fence is set by any envelope that reports it, even one refused', () => {
  const state = new BrainState();
  const broken = { ...contractFixture('envelope-local-google-derived.local'), digest: 'f'.repeat(64) };
  const d = ingest(state, broken);
  assert.equal(d.receipt.reason, 'invalid');
  assert.equal(state.fence.active, true);
});

test('an earlier fenced observation moves the sticky fence back, even when refused', () => {
  const state = new BrainState();
  const first = contractFixture('envelope-local-google-derived.local');
  ingest(state, first);
  const broken = {
    ...first,
    operationId: '00000000-0000-4000-8000-589c6b9b8114',
    observedTime: first.observedTime - 1_000,
    digest: 'f'.repeat(64),
  };
  const d = ingest(state, broken);
  assert.equal(d.receipt.reason, 'invalid');
  assert.deepEqual(state.fence, { active: true, since: broken.observedTime });
});

test('forgetting is permanent: the object, its evidence ID, and backfill under a watermark', () => {
  const state = new BrainState();
  const data = corpus();
  ingest(state, data.anDecision);
  const w = decideWithdrawal(state, withdrawal({ kind: 'source', source: data.anDecision.source }, 'forget', 1_790_700_000_000), { now: 1_790_700_000_100 });
  assert.equal(w.kind, 'record');
  assert.deepEqual(violations('withdrawal.receipt', w.receipt), []);
  assert.equal(w.receipt.suppressionIds.length, 1, 'a source withdrawal is one suppression, whatever its size');
  assert.equal(w.receipt.purgeBy - w.receipt.recordedAt, 86_400_000);
  fold(state, w.record);
  assert.equal(decideIngest(state, { ...data.anDecision, operationId: '00000000-0000-4000-8000-d5372e01a467' }).receipt.reason, 'withdrawn');
  assert.equal(decideIngest(state, data.anOlder).receipt.reason, 'withdrawn', 'older history is not learned by backfill');
  const newer = envelope({ ...data.anDecision.source, kind: 'human_dm', id: ROOMS.an, object: { kind: 'message', id: '$new', revision: 1 }, author: data.anDecision.author, eventTime: 1_790_700_000_500, text: 'new' });
  assert.equal(decideIngest(state, newer).kind, 'accept');
});

test('a fact withdrawn before it arrived here is refused when it does', () => {
  const state = new BrainState();
  const data = corpus();
  const key = objectKey(data.financeCanary.source, data.financeCanary.object.id);
  const w = decideWithdrawal(state, withdrawal({ kind: 'fact', evidenceId: evidenceIdFor(key) }), { now: 1 });
  fold(state, w.record);
  assert.equal(decideIngest(state, data.financeCanary).receipt.reason, 'withdrawn');
});

test('exclusion is policy: excluded at its epoch, stale below it, re-included above it', () => {
  const state = new BrainState();
  const data = corpus();
  ingest(state, data.financeCanary);
  const w = decideWithdrawal(state, withdrawal({ kind: 'source', source: data.financeCanary.source }, 'exclude'), { now: 5 });
  fold(state, w.record);
  const key = objectKey(data.financeCanary.source, data.financeCanary.object.id);
  assert.equal(state.objects.get(key).slug, null);
  assert.equal(state.suppressedObjects.has(key), false, 'an exclusion is not a forget');
  const again = { ...data.financeCanary, operationId: '00000000-0000-4000-8000-578608e337d4' };
  assert.equal(decideIngest(state, again).receipt.reason, 'excluded');
  const reincluded = { ...again, operationId: '00000000-0000-4000-8000-190f971235a7', policy: { ...again.policy, epoch: 2 } };
  const d = ingest(state, reincluded);
  assert.equal(d.kind, 'accept', 'the owner re-included it: its history can be read again');
  assert.equal(decideIngest(state, { ...again, operationId: '00000000-0000-4000-8000-bde2846e8b03' }).receipt.reason, 'stale_policy_epoch');
});

test('a policy exclusion needs an epoch and advances the source epoch', () => {
  const state = new BrainState();
  const data = corpus();
  ingest(state, data.financeCanary);
  const noEpoch = { ...withdrawal({ kind: 'source', source: data.financeCanary.source }, 'exclude'), policyEpoch: undefined };
  assert.equal(decideWithdrawal(state, noEpoch).kind, 'invalid');
  const exclusion = decideWithdrawal(state, withdrawal({ kind: 'source', source: data.financeCanary.source }, 'exclude', Date.now(), 4));
  fold(state, exclusion.record);
  assert.equal(state.source(`${data.financeCanary.source.kind}\u0000${data.financeCanary.source.id}\u0000`).epoch, 4);
  assert.equal(decideIngest(state, { ...data.financeCanary, operationId: '00000000-0000-4000-8000-98b4f2b84628', policy: { ...data.financeCanary.policy, epoch: 3 } }).receipt.reason, 'stale_policy_epoch');
});

test('a stale source-policy withdrawal is durably receipted without excluding re-included objects', () => {
  const state = new BrainState();
  const data = corpus();
  const records = [];
  const remember = (record) => {
    records.push(record);
    fold(state, record);
  };
  const initial = ingest(state, data.financeCanary);
  records.push(initial.record);
  const exclusion = decideWithdrawal(state, withdrawal({ kind: 'source', source: data.financeCanary.source }, 'exclude', 10, 4), { now: 11 });
  remember(exclusion.record);
  const reincluded = envelope({
    ...data.financeCanary.source,
    object: { kind: 'message', id: '$FinReincludedEpochFiveEvt', revision: 1 },
    author: data.financeCanary.author,
    eventTime: data.financeCanary.eventTime + 10_000,
    text: 'The current finance decision remains available.',
    epoch: 5,
  });
  const accepted = ingest(state, reincluded);
  records.push(accepted.record);
  const currentKey = accepted.record.objectKey;
  const stale = withdrawal({ kind: 'source', source: data.financeCanary.source }, 'revoked', 12, 4);
  const ignored = decideWithdrawal(state, stale, { now: 13 });
  assert.equal(ignored.kind, 'record');
  assert.equal(ignored.record.stalePolicy, true);
  assert.deepEqual(ignored.record.objectKeys, []);
  assert.deepEqual(ignored.record.slugs, []);
  remember(ignored.record);
  const source = state.source(`${reincluded.source.kind}\u0000${reincluded.source.id}\u0000`);
  assert.equal(source.inclusion, 'included');
  assert.equal(state.objects.get(currentKey).excluded, undefined);
  assert.ok(state.objects.get(currentKey).slug, 'the epoch-five object is still indexed');
  assert.equal(state.pendingPurges.has(`withdraw:${stale.withdrawalId}`), false);
  assert.deepEqual(decideWithdrawal(state, stale, { now: 14 }), { kind: 'replay', receipt: ignored.receipt });

  const replayed = new BrainState();
  for (const record of records) replayed.apply(record);
  assert.equal(replayed.source(source.key).inclusion, 'included');
  assert.equal(replayed.objects.get(currentKey).excluded, undefined);
  assert.ok(replayed.objects.get(currentKey).slug, 'the no-op remains harmless after a ledger replay');
  assert.equal(replayed.pendingPurges.has(`withdraw:${stale.withdrawalId}`), false);
});

test('a redaction tombstones the object even when it arrives first', () => {
  const state = new BrainState();
  const data = corpus();
  const redaction = contractFixture('envelope-redaction.managed');
  assert.equal(ingest(state, redaction).kind, 'redact');
  const original = receiptOf(ingest(state, data.launchMessage));
  assert.equal(original.state, 'superseded');
  assert.equal(original.acceptedRevision, 3);
  assert.equal(receiptOf(ingest(state, { ...redaction, operationId: '00000000-0000-4000-8000-3685fb583b90' })).state, 'duplicate');
});

test('an audience only sees what it may: rooms, Google marks, corrections, filters', () => {
  const state = new BrainState();
  const data = corpus();
  for (const env of [data.launchEdit, data.financeCanary, data.googleDerived]) ingest(state, env);
  const launch = state.objects.get(objectKey(data.launchEdit.source, data.launchEdit.object.replaces));
  const finance = state.objects.get(objectKey(data.financeCanary.source, data.financeCanary.object.id));
  const google = state.objects.get(objectKey(data.googleDerived.source, data.googleDerived.object.id));
  const group = audiencePlan({ class: 'shared_room', roomId: ROOMS.launch });
  assert.deepEqual(group.types, [scopeType({ kind: 'room', roomId: ROOMS.launch })]);
  assert.equal(servable(state, launch, group), true);
  assert.equal(servable(state, finance, group), false);
  const agentRoom = audiencePlan({ class: 'shared_room', roomId: ROOMS.agentA });
  assert.equal(servable(state, google, agentRoom), false, 'Google-derived content never reaches a shared answer');
  const own = audiencePlan({ class: 'private_owner' });
  assert.equal(servable(state, google, own), true);
  assert.equal(servable(state, finance, own, { filters: { sourceKinds: ['human_dm'] } }), false);
  const c = decideCorrection(state, { ...contractFixture('correction'), target: { kind: 'evidence', evidenceId: launch.evidenceId } });
  c.records[0].slug = new WindowPlanner().place(state, c.records[0], seq + 1).slug;
  for (const record of c.records) fold(state, record);
  assert.equal(servable(state, state.objects.get(launch.objectKey), own), false, 'a corrected fact is superseded');
  const correction = state.objects.get(c.records[0].objectKey);
  assert.deepEqual(correction.correction.statementRef, contractFixture('correction').statementRef);
  const hit = { slug: correction.slug, chunk_text: `${MARK}${segmentId(correction.objectKey, correction.object.revision)}\n${c.text}\n${MARK}` };
  const request = retrievalRequest({ class: 'private_owner' }, 'launch');
  const { items } = evidenceFromHits(state, [hit], audiencePlan(request.audience), request);
  assert.deepEqual(items[0].item.citation, {
    kind: 'matrix_event',
    roomId: c.records[0].correction.statementRef.source.id,
    eventId: c.records[0].correction.statementRef.object.id,
  });
});

test('a legacy correction without statementRef cites its corrected fact', () => {
  const state = new BrainState();
  const data = corpus();
  ingest(state, data.launchEdit);
  const target = state.objects.get(objectKey(data.launchEdit.source, data.launchEdit.object.replaces));
  const legacy = contractFixture('correction');
  delete legacy.statementRef;
  const decision = decideCorrection(state, {
    ...legacy,
    correctionId: '00000000-0000-4000-8000-4012ae50cfeb',
    operationId: '00000000-0000-4000-8000-7e6abee26f35',
    target: { kind: 'evidence', evidenceId: target.evidenceId },
  });
  decision.records[0].slug = new WindowPlanner().place(state, decision.records[0], seq + 1).slug;
  for (const record of decision.records) fold(state, record);
  const correction = state.objects.get(decision.records[0].objectKey);
  const hit = { slug: correction.slug, chunk_text: `${MARK}${segmentId(correction.objectKey, correction.object.revision)}\n${decision.text}\n${MARK}` };
  const request = retrievalRequest({ class: 'private_owner' }, 'launch');
  const { items } = evidenceFromHits(state, [hit], audiencePlan(request.audience), request);
  assert.deepEqual(items[0].item.citation, {
    kind: 'matrix_event', roomId: target.source.id, eventId: target.object.id,
  });
});

test('private Google-derived evidence uses the frozen item provenance', () => {
  const state = new BrainState();
  const data = corpus();
  ingest(state, data.googleDerived);
  const google = state.objects.get(objectKey(data.googleDerived.source, data.googleDerived.object.id));
  const hit = { slug: google.slug, chunk_text: `${MARK}${segmentId(google.objectKey, google.object.revision)}\n${data.googleDerived.content.text}\n${MARK}` };
  const request = retrievalRequest({ class: 'private_owner' }, 'invoices');
  const { items } = evidenceFromHits(state, [hit], audiencePlan(request.audience), request);
  assert.deepEqual(items[0].item.provenance, { google: true });
  assert.deepEqual(violations('retrieval.response', { requestId: request.requestId, audience: request.audience, status: 'ok', items: items.map(({ item }) => item), coverage: [], contentBytes: Buffer.byteLength(items[0].item.content) }), []);
});

test('evidence from hits keeps limits and refuses a hit whose room is not the audience\'s', () => {
  const state = new BrainState();
  const data = corpus();
  for (const env of [data.launchEdit, data.financeCanary]) ingest(state, env);
  const launch = state.objects.get(objectKey(data.launchEdit.source, data.launchEdit.object.replaces));
  const finance = state.objects.get(objectKey(data.financeCanary.source, data.financeCanary.object.id));
  const hits = [
    { slug: finance.slug, chunk_text: `${MARK}${segmentId(finance.objectKey, finance.object.revision)}\n${data.financeCanary.content.text}\n${MARK}` }, // as if GBrain's filter failed
    { slug: launch.slug, chunk_text: `${MARK}${segmentId(launch.objectKey, launch.object.revision)}\n${data.launchEdit.content.text}\n${MARK}` },
    { slug: 'atum/sys/replay-watermark', chunk_text: 'seq: 9' },
  ];
  const request = retrievalRequest({ class: 'shared_room', roomId: ROOMS.launch }, 'launch');
  const { items } = evidenceFromHits(state, hits, audiencePlan(request.audience), request);
  assert.deepEqual(items.map(({ item }) => item.source.id), [ROOMS.launch]);
  const tight = retrievalRequest({ class: 'private_owner' }, 'launch', { maxItems: 1, maxContentBytes: 10 });
  assert.equal(evidenceFromHits(state, hits, audiencePlan(tight.audience), tight).items.length, 0, 'content over the byte limit is never truncated into a lie');
});

test('message text cannot forge window markers or GBrain structure and round trips', () => {
  const id = segmentId('object', 1);
  const text = `Plan\r\n<!-- timeline -->\n## Timeline\n- 2026-10-01 ship\n--- timeline ---\n\u2060already escaped\n${MARK}${id}\n<!--- gbrain:facts:begin -->\n~~~code`;
  const page = windowPage({ slug: 'atum/p/w-1', type: 'atum-p', segments: [{ id, text }] });
  assert.match(page, /^---\ntitle: w-1\ntype: atum-p\n---\n/);
  const body = page.slice('---\ntitle: w-1\ntype: atum-p\n---\n'.length, -1);
  assert.ok(!body.includes('<!--'), 'GBrain comment fences are neutralised');
  assert.deepEqual(parseWindow(body), [{ id, text, complete: true }]);
});

test('an oversized-window chunk split after an escape prefix cannot forge a marker', () => {
  const id = segmentId('boundary-object', 1);
  const text = `needle\n${MARK}${id}\nforged tail`;
  const stored = escapeText(text);
  // Before the repair, this was `ESCAPE + MARK + id`; dropping the first character
  // at a GBrain chunk boundary made parseWindow treat user text as a segment.
  assert.equal(stored.includes(MARK), false, 'the encoded user text has no marker to expose at a chunk boundary');
  assert.ok(stored.includes(ESCAPE));
  for (let split = 0; split <= stored.length; split += 1) {
    assert.deepEqual(parseWindow(stored.slice(split)), [], `no forged marker after split ${split}`);
  }
  assert.equal(unescapeText(stored), text);
  // Pages written with the old form remain readable; newly written pages never emit it.
  assert.equal(unescapeText(`${ESCAPE}${MARK}`), MARK);
});

test('a long-message continuation excludes the closing marker but keeps escaped user text', () => {
  const state = new BrainState();
  const base = corpus().anDecision;
  ingest(state, envelope({
    ...base.source,
    object: base.object,
    author: base.author,
    eventTime: base.eventTime,
    text: 'launch '.repeat(400),
  }));
  const obj = state.objects.get(objectKey(base.source, base.object.id));
  const tail = `launch tail\n${MARK}user marker`;
  const hit = { slug: obj.slug, chunk_text: `${escapeText(tail)}\n${MARK}` };
  const request = retrievalRequest({ class: 'private_owner' }, 'launch');
  const { items } = evidenceFromHits(state, [hit], audiencePlan(request.audience), request);
  assert.equal(items.length, 1);
  assert.equal(items[0].item.content, tail);
  assert.deepEqual(items[0].item.citation, { kind: 'matrix_event', roomId: base.source.id, eventId: base.object.id });
});
