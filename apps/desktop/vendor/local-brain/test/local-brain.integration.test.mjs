// S3's local half against the real pinned GBrain (v0.59.20.0, PGLite 0.4.3): recall
// with citations, audience separation, withdrawal down to the datastore's bytes, restore
// that replays withdrawals before serving, one owning process, and the fence.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startLocalBrain } from '../src/client.mjs';
import { violations } from '../src/contract.mjs';
import { restoreBackup } from '../src/service.mjs';
import { layout } from '../src/paths.mjs';
import {
  AGENTS, APP, CANARY_AGENT_B, CANARY_FINANCE, ROOMS, contractFixture, corpus, envelope, retrievalRequest, withdrawal,
} from './fixtures/corpus.mjs';
import { platformKey } from '../src/pin.mjs';
import { binary, filesHolding, gbrainDirect, needBinary, pin, removeRoot, tempRoot, waitFor } from './helpers.mjs';

const PRIVATE = { class: 'private_owner' };
const room = (roomId) => ({ class: 'shared_room', roomId });

const conforms = (message, body) => assert.deepEqual(violations(message, body), [], `${message} does not conform`);

async function ingestAll(brain, envelopes) {
  const receipts = {};
  for (const [name, env] of Object.entries(envelopes)) receipts[name] = await brain.ingest(env);
  return receipts;
}

describe('recall with citations, and audiences kept apart', { skip: needBinary }, () => {
  let root;
  let brain;
  let receipts;
  const data = corpus();

  before(async () => {
    root = tempRoot();
    brain = await startLocalBrain({ root, binary });
    receipts = await ingestAll(brain, data);
  });
  after(async () => {
    await brain?.stop();
    removeRoot(root);
  });

  test('every envelope is accepted with a conforming receipt', () => {
    for (const [name, receipt] of Object.entries(receipts)) {
      conforms('ingestion.receipt', receipt);
      assert.equal(receipt.state, 'accepted', `${name}: ${JSON.stringify(receipt)}`);
    }
  });

  test('a replay, a second device and a stale revision are one ingestion', async () => {
    const replay = await brain.ingest(data.launchMessage);
    assert.equal(replay.state, 'duplicate', 'a retry of the same operation');
    const secondDevice = await brain.ingest({ ...data.launchEdit, operationId: '00000000-0000-4000-8000-eb1cbfd13854' });
    assert.equal(secondDevice.state, 'duplicate', 'the held revision from a second device');
    assert.equal(secondDevice.acceptedRevision, 2);
    const late = await brain.ingest({ ...data.launchMessage, operationId: '00000000-0000-4000-8000-979ccaef9b49' });
    assert.equal(late.state, 'superseded', 'an older revision than the one held');
    assert.equal(late.acceptedRevision, 2);
  });

  test('a private question gets cited answers across the group and Drive', async () => {
    // Keyword retrieval (no embedding provider) matches words, not meaning: a question
    // across languages needs the semantic mode (see the S3 findings).
    const response = await brain.retrieve(retrievalRequest(PRIVATE, 'October'));
    conforms('retrieval.response', response);
    assert.equal(response.status, 'ok');
    const bySource = Object.fromEntries(response.items.map((item) => [item.source.id, item]));
    const group = bySource[ROOMS.launch];
    assert.ok(group, 'the group decision is recalled');
    assert.equal(group.content, "Let's move the launch to 15 October.", 'the edit supersedes the original');
    assert.deepEqual(group.citation, { kind: 'matrix_event', roomId: ROOMS.launch, eventId: data.launchEdit.object.id });
    assert.deepEqual(group.derivation.sourceRefs, [data.launchMessage.object]);
    assert.equal(group.digest, data.launchEdit.digest);
    const drive = response.items.find((item) => item.source.kind === 'drive_file');
    assert.ok(drive, 'the Drive file is recalled');
    assert.deepEqual(drive.citation, { kind: 'drive_file', fileId: data.driveFile.object.id, version: '4' });
    for (const item of response.items) assert.equal(item.untrustedInput, true);
    assert.ok(response.contentBytes <= 16_384);
  });

  test('Vietnamese recall finds the DM decision', async () => {
    const response = await brain.retrieve(retrievalRequest(PRIVATE, 'chốt ngày nhà đầu tư'));
    conforms('retrieval.response', response);
    const dm = response.items.find((item) => item.source.id === ROOMS.an);
    assert.ok(dm, JSON.stringify(response.items.map((i) => i.content)));
    assert.deepEqual(dm.citation, { kind: 'matrix_event', roomId: ROOMS.an, eventId: data.anDecision.object.id });
  });

  test('a group answer uses only that group, however the question fishes', async () => {
    for (const query of ['launch', 'salary', CANARY_FINANCE, 'competitor pricing research', 'invoices inbox', 'Vietnamese morning updates']) {
      const response = await brain.retrieve(retrievalRequest(room(ROOMS.launch), query));
      conforms('retrieval.response', response);
      for (const item of response.items) {
        assert.equal(item.scope.roomId, ROOMS.launch, `${query}: ${JSON.stringify(item)}`);
      }
      const wire = JSON.stringify(response);
      assert.ok(!wire.includes(CANARY_FINANCE) && !wire.includes(CANARY_AGENT_B), `${query}: a canary crossed audiences`);
      assert.ok(!wire.includes(ROOMS.finance) && !wire.includes(ROOMS.an), `${query}: another room's metadata crossed`);
      assert.ok(!wire.includes('invoices'), `${query}: Google-derived content reached a shared answer`);
      assert.deepEqual(response.coverage.map((entry) => entry.source.id), [ROOMS.launch]);
    }
  });

  test('two agents answering in their own rooms never see each other', async () => {
    const a = await brain.retrieve(retrievalRequest(room(ROOMS.agentA), 'launch research pricing deck', { agentPrincipal: AGENTS.a }));
    const b = await brain.retrieve(retrievalRequest(room(ROOMS.agentB), 'launch research pricing deck', { agentPrincipal: AGENTS.b }));
    conforms('retrieval.response', a);
    conforms('retrieval.response', b);
    assert.ok(a.items.length >= 1 && b.items.length >= 1);
    assert.ok(a.items.every((item) => item.scope.roomId === ROOMS.agentA));
    assert.ok(b.items.every((item) => item.scope.roomId === ROOMS.agentB));
    assert.ok(!JSON.stringify(a).includes(CANARY_AGENT_B));
    // Agent A's curated memory is private: never in a room's answer.
    assert.ok(!JSON.stringify(a).includes('prefers launch updates'));
  });

  test('a partner answer sees only its thread', async () => {
    const response = await brain.retrieve(retrievalRequest({ class: 'partner', roomId: ROOMS.appThread, appId: APP }, 'launch week signing'));
    conforms('retrieval.response', response);
    assert.ok(response.items.length >= 1);
    assert.ok(response.items.every((item) => item.scope.roomId === ROOMS.appThread));
  });

  test('concurrent answers for different audiences never bleed into each other', async () => {
    const requests = [];
    for (let i = 0; i < 12; i += 1) {
      const audience = [room(ROOMS.launch), room(ROOMS.finance), room(ROOMS.agentB), PRIVATE][i % 4];
      requests.push(brain.retrieve(retrievalRequest(audience, i % 2 ? 'launch' : 'salary launch research')).then((response) => ({ audience, response })));
    }
    for (const { audience, response } of await Promise.all(requests)) {
      conforms('retrieval.response', response);
      if (audience.class === 'shared_room') {
        assert.ok(response.items.every((item) => item.scope.roomId === audience.roomId), JSON.stringify(response.items.map((i) => i.scope)));
      }
    }
  });

  test('private answers carry Google provenance on the evidence item; filters narrow', async () => {
    const response = await brain.retrieveLocal(retrievalRequest(PRIVATE, 'invoices inbox'));
    conforms('retrieval.response', response);
    const google = response.items.find((item) => item.content.includes('invoices'));
    assert.ok(google, 'the local brain may recall Google-derived content privately');
    assert.deepEqual(google.provenance, { google: true });
    const plain = await brain.retrieveLocal(retrievalRequest(PRIVATE, 'launch October'));
    assert.ok(plain.items.every((item) => item.provenance === undefined));
    const dmOnly = await brain.retrieve(retrievalRequest(PRIVATE, 'launch', { filters: { sourceKinds: ['human_dm'] } }));
    assert.ok(dmOnly.items.every((item) => item.source.kind === 'human_dm'));
    const late = await brain.retrieve(retrievalRequest(PRIVATE, 'launch', { filters: { since: 1_790_600_000_000 } }));
    assert.ok(late.items.every((item) => item.eventTime >= 1_790_600_000_000));
  });

  test('limits hold: at most maxItems, maxContentBytes, and 8,192 characters an item', async () => {
    const response = await brain.retrieve(retrievalRequest(PRIVATE, 'launch', { maxItems: 2, maxContentBytes: 60 }));
    conforms('retrieval.response', response);
    assert.ok(response.items.length <= 2);
    assert.ok(response.contentBytes <= 60);
    assert.equal(response.contentBytes, response.items.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0));
  });

  test('nothing can be forged: a request or an envelope naming an owner is refused', async () => {
    await assert.rejects(brain.retrieve({ ...retrievalRequest(PRIVATE, 'launch'), owner: 'someone-else' }), /not a retrieval request/);
    const forged = await brain.ingest({ ...data.anDecision, operationId: '00000000-0000-4000-8000-a3653599a176', owner: '@x:y' });
    assert.equal(forged.state, 'refused');
    assert.equal(forged.reason, 'invalid');
    const managedGoogle = contractFixture('envelope-google-derived-to-managed.managed');
    const marked = { ...managedGoogle, operationId: '00000000-0000-4000-8000-abc425e4ad5f', object: { ...managedGoogle.object, id: '$GoogleDerivedEvt2aB3cD4eF5gH6iJ7kL8mN9o' } };
    assert.equal((await brain.ingest(marked)).state, 'accepted',
      'the local brain on the latched Mac may index Google-derived content (envelope.local)');
  });

  test('a correction supersedes the fact privately and cites its frozen owner statement', async () => {
    const before = await brain.retrieve(retrievalRequest(PRIVATE, 'launch October'));
    const target = before.items.find((item) => item.source.id === ROOMS.launch);
    const request = {
      ...contractFixture('correction'),
      operationId: '00000000-0000-4000-8000-a5a04b95bbfa',
      target: { kind: 'evidence', evidenceId: target.evidenceId },
    };
    const result = await brain.correct(request);
    assert.deepEqual(result, {
      correctionId: '00000000-0000-4000-8000-f0cca65fbb6d',
      state: 'recorded',
      evidenceId: result.evidenceId,
    });
    conforms('correction.receipt', result);
    const after = await brain.retrieve(retrievalRequest(PRIVATE, 'launch October'));
    conforms('retrieval.response', after);
    assert.ok(!after.items.some((item) => item.evidenceId === target.evidenceId), 'the corrected fact is not served as current');
    const correction = after.items.find((item) => item.epistemic === 'correction');
    assert.ok(correction, JSON.stringify(after.items.map((i) => [i.epistemic, i.content])));
    assert.equal(correction.content, 'The launch is on 16 October, not 15.');
    assert.deepEqual(correction.derivation.parents, [target.evidenceId]);
    assert.deepEqual(correction.citation, {
      kind: 'matrix_event',
      roomId: request.statementRef.source.id,
      eventId: request.statementRef.object.id,
    });
    const shared = await brain.retrieve(retrievalRequest(room(ROOMS.launch), 'launch October'));
    assert.ok(!shared.items.some((item) => item.epistemic === 'correction'), 'a private correction never reaches the group');
  });

  test('coverage is honest: what the reader reports is merged, and a paused source is never ready', async () => {
    await brain.reportCoverage({ entries: [
      { source: { kind: 'human_group', id: ROOMS.finance }, state: 'needs_keys', reasons: ['keys_missing'], asOf: Date.now() },
    ] });
    const { summary, entries } = await brain.coverage();
    conforms('coverage.summary', summary);
    for (const entry of entries) conforms('coverage.entry', entry);
    assert.equal(entries.find((entry) => entry.source.id === ROOMS.finance).state, 'needs_keys');
    assert.equal(summary.state, 'needs_keys');
    const response = await brain.retrieve(retrievalRequest(PRIVATE, 'salary'));
    assert.equal(response.status, 'degraded');
  });
});

describe('withdrawal: recorded first, recall stops at once, bytes purged', { skip: needBinary }, () => {
  let root;
  let brain;
  const data = corpus();

  before(async () => {
    root = tempRoot();
    brain = await startLocalBrain({ root, binary });
    await ingestAll(brain, data);
  });
  after(async () => {
    await brain?.stop();
    removeRoot(root);
  });

  test('forgetting a fact: a conforming receipt, no recall, and it can\'t come back', async () => {
    const first = await brain.retrieve(retrievalRequest(PRIVATE, 'launch October'));
    const fact = first.items.find((item) => item.source.id === ROOMS.launch);
    const request = withdrawal({ kind: 'fact', evidenceId: fact.evidenceId });
    const receipt = await brain.withdraw(request);
    conforms('withdrawal.receipt', receipt);
    assert.ok(receipt.purgeBy - receipt.recordedAt <= 86_400_000);
    assert.deepEqual(await brain.withdraw(request), receipt, 'a replayed withdrawal gets the same receipt');
    const after = await brain.retrieve(retrievalRequest(PRIVATE, 'launch October'));
    assert.ok(!after.items.some((item) => item.evidenceId === fact.evidenceId));
    for (const [index, env] of [data.launchMessage, data.launchEdit].entries()) {
      const again = await brain.ingest({ ...env, operationId: `0f1e2d3c-4b5a-4968-8776-0000000000a${index}` });
      assert.equal(again.state, 'refused');
      assert.equal(again.reason, 'withdrawn');
    }
    const laterEdit = envelope({
      kind: 'human_group', id: ROOMS.launch,
      object: { kind: 'edit', id: '$LnchDecisionEdit3xY', revision: 5, replaces: data.launchMessage.object.id },
      author: data.launchEdit.author, eventTime: data.launchEdit.eventTime + 1000, text: "Let's move the launch to 17 October.", epoch: 3,
    });
    assert.equal((await brain.ingest(laterEdit)).reason, 'withdrawn', 'a later edit of a forgotten fact is not learned');
  });

  test('forgetting a whole conversation holds against backfill, but new messages still come in', async () => {
    const receipt = await brain.withdraw(withdrawal({ kind: 'source', source: { kind: 'human_dm', id: ROOMS.an } }, 'forget'));
    conforms('withdrawal.receipt', receipt);
    const response = await brain.retrieve(retrievalRequest(PRIVATE, 'chốt ngày nhà đầu tư ngân sách'));
    assert.ok(!response.items.some((item) => item.source.id === ROOMS.an));
    const backfill = await brain.ingest({ ...data.anOlder, operationId: '00000000-0000-4000-8000-41ddc201d198' });
    assert.equal(backfill.reason, 'withdrawn');
    const fresh = envelope({
      kind: 'human_dm', id: ROOMS.an, object: { kind: 'message', id: '$AnNewEvtAfterForget0000000000000000', revision: 1 },
      author: { kind: 'human', id: '@synthetic-user-0006:atumplatform.com' }, eventTime: Date.now() + 60_000, text: 'Mai gặp lại nhé.',
    });
    assert.equal((await brain.ingest(fresh)).state, 'accepted');
  });

  test('excluding a source: the old epoch is stale, the same epoch excluded, a newer epoch re-includes', async () => {
    await brain.withdraw(withdrawal({ kind: 'source', source: { kind: 'human_group', id: ROOMS.finance } }, 'exclude'));
    const sameEpoch = envelope({
      kind: 'human_group', id: ROOMS.finance, object: { kind: 'message', id: '$FinNextEvt000000000000000000000001', revision: 1 },
      author: { kind: 'human', id: '@synthetic-user-0007:atumplatform.com' }, eventTime: Date.now() + 120_000, text: 'Budget sign-off tomorrow.', epoch: 1,
    });
    assert.equal((await brain.ingest(sameEpoch)).reason, 'excluded');
    const reincluded = { ...sameEpoch, operationId: '00000000-0000-4000-8000-e1e108acc1d6', policy: { ...sameEpoch.policy, epoch: 2 } };
    assert.equal((await brain.ingest(reincluded)).state, 'accepted');
    const stale = { ...sameEpoch, operationId: '00000000-0000-4000-8000-f779605ecde0', object: { ...sameEpoch.object, id: '$FinStaleEvt00000000000000000000001' } };
    assert.equal((await brain.ingest(stale)).reason, 'stale_policy_epoch');
    const salary = await brain.retrieve(retrievalRequest(PRIVATE, CANARY_FINANCE));
    assert.ok(!JSON.stringify(salary).includes(CANARY_FINANCE), 'excluded history stays purged after re-inclusion until backfilled');
  });

  test('a redaction removes the message and wins over a late copy of it', async () => {
    const note = await brain.retrieve(retrievalRequest(PRIVATE, 'investor deck Friday'));
    assert.ok(note.items.some((item) => item.source.id === ROOMS.agentA));
    const redaction = envelope({
      kind: 'assistant_chat', id: ROOMS.agentA, agentPrincipal: AGENTS.a,
      object: { kind: 'redaction', id: '$RedactAgentANote000000000000000001', revision: 2, replaces: data.agentANote.object.id },
      author: { kind: 'owner', id: '@synthetic-user-0004:atumplatform.com' }, eventTime: data.agentANote.eventTime + 5000, text: '',
    });
    assert.equal((await brain.ingest(redaction)).state, 'accepted');
    const gone = await brain.retrieve(retrievalRequest(PRIVATE, 'investor deck Friday'));
    assert.ok(!gone.items.some((item) => item.source.id === ROOMS.agentA));
    const late = await brain.ingest({ ...data.agentANote, operationId: '00000000-0000-4000-8000-166a4e0ff4e7' });
    assert.equal(late.state, 'superseded');
  });

  test('GBrain itself no longer has the withdrawn pages, and compaction leaves no bytes behind', async () => {
    const info = await brain.info();
    assert.ok(info.purgeDebt, 'withdrawals leave a purge debt until compaction');
    await brain.stop();
    const direct = await gbrainDirect(root, 'search', { query: 'launch October' });
    assert.ok(direct.ok, direct.message);
    assert.ok(!direct.value.some((hit) => hit.chunk_text?.includes('launch to 15 October')), 'the withdrawn text is not in GBrain\'s index');
    assert.ok(direct.value.some((hit) => hit.chunk_text?.includes('ship the trial on 15 October')), 'the live Drive text still is');
    const salary = await gbrainDirect(root, 'search', { query: CANARY_FINANCE });
    assert.ok(!salary.value.some((hit) => hit.chunk_text?.includes(CANARY_FINANCE)), 'the excluded group is purged from GBrain\'s index');
    // Logical purge is not physical: GBrain keeps each write's request (with its text)
    // for 30 days, and PGLite keeps deleted rows in its files.
    const lingering = await filesHolding(root, 'launch to 15 October');
    assert.ok(lingering.length > 0, 'expected the withdrawn bytes to linger before compaction');
    brain = await startLocalBrain({ root, binary });
    const result = await brain.compact();
    assert.ok(result.pages >= 4, JSON.stringify(result));
    assert.equal((await brain.info()).purgeDebt, null);
    const still = await brain.retrieve(retrievalRequest(PRIVATE, 'Drive trial plan'));
    assert.ok(still.items.some((item) => item.source.kind === 'drive_file'), 'live evidence survives compaction');
    await brain.stop();
    for (const needle of ['launch to 15 October', 'launch to 14 October', CANARY_FINANCE, 'nhà đầu tư', 'investor launch deck']) {
      assert.deepEqual(await filesHolding(root, needle), [], `"${needle}" is still in the datastore's files after compaction`);
    }
    const ledgerText = readFileSync(join(root, 'ledger', 'ledger.jsonl'), 'utf8');
    for (const needle of ['launch to 15 October', 'Q4 plan', CANARY_FINANCE, 'investor launch deck']) {
      assert.ok(!ledgerText.includes(needle), `the ledger holds message text ("${needle}")`);
    }
    assert.ok((await filesHolding(root, 'Q4 plan: ship the trial')).length > 0, 'the live Drive text is still there');
    brain = await startLocalBrain({ root, binary });
  });
});

describe('compaction is online: work goes on during the copy', { skip: needBinary }, () => {
  let root;
  let brain;
  const data = corpus();
  before(async () => {
    root = tempRoot();
    brain = await startLocalBrain({ root, binary });
    await ingestAll(brain, data);
  });
  after(async () => {
    await brain?.stop();
    removeRoot(root);
  });

  test('an ingest and a withdrawal made during compaction both hold afterwards', async () => {
    const drive = (await brain.retrieve(retrievalRequest(PRIVATE, 'Q4 trial'))).items.find((item) => item.source.kind === 'drive_file');
    assert.ok(drive);
    const compaction = brain.compact();
    const late = envelope({
      kind: 'human_group', id: ROOMS.launch, object: { kind: 'message', id: '$DuringCompactionEvt000000000000001', revision: 1 },
      author: data.launchMessage.author, eventTime: Date.now(), text: 'Rehearsal booked for Thursday at the studio.', epoch: 3,
    });
    const [receipt, withdrawn] = await Promise.all([
      brain.ingest(late),
      brain.withdraw(withdrawal({ kind: 'fact', evidenceId: drive.evidenceId })),
      brain.retrieve(retrievalRequest(PRIVATE, 'launch')),
    ]);
    assert.equal(receipt.state, 'accepted');
    conforms('withdrawal.receipt', withdrawn);
    const result = await compaction;
    assert.ok(result.pages >= 5, JSON.stringify(result));
    const rehearsal = await brain.retrieve(retrievalRequest(PRIVATE, 'rehearsal studio'));
    assert.equal(rehearsal.items.length, 1, 'the message ingested during compaction is in the new datastore');
    const q4 = await brain.retrieve(retrievalRequest(PRIVATE, 'Q4 trial'));
    assert.ok(!q4.items.some((item) => item.evidenceId === drive.evidenceId), 'the fact withdrawn during compaction stays withdrawn');
    await brain.stop();
    const direct = await gbrainDirect(root, 'search', { query: 'Q4 plan trial' });
    assert.ok(!direct.value.some((hit) => hit.chunk_text?.includes('ship the trial on 15 October')), 'and GBrain itself no longer has it');
    brain = await startLocalBrain({ root, binary });
  });

  test('only one compaction runs at a time', async () => {
    const first = brain.compact();
    await assert.rejects(brain.compact(), (error) => error.code === -32001);
    await first;
  });
});

describe('restore replays withdrawals before serving anything', { skip: needBinary }, () => {
  let root;
  let backupDir;
  const data = corpus();

  before(() => {
    root = tempRoot();
    backupDir = tempRoot('lb-backups-');
  });
  after(() => {
    removeRoot(root);
    removeRoot(backupDir);
  });

  test('a backup from before a withdrawal comes back without the withdrawn fact', async () => {
    let brain = await startLocalBrain({ root, binary });
    await ingestAll(brain, { launchMessage: data.launchMessage, launchEdit: data.launchEdit, driveFile: data.driveFile, financeCanary: data.financeCanary });
    const backup = await brain.backup(join(backupDir, 'before.tar.gz'));
    assert.match(backup.sha256, /^[0-9a-f]{64}$/);
    const fact = (await brain.retrieve(retrievalRequest(PRIVATE, 'launch October'))).items.find((item) => item.source.id === ROOMS.launch);
    await brain.withdraw(withdrawal({ kind: 'fact', evidenceId: fact.evidenceId }));
    const afterBackup = envelope({
      kind: 'human_group', id: ROOMS.launch, object: { kind: 'message', id: '$AfterBackupEvt0000000000000000000001', revision: 1 },
      author: data.launchMessage.author, eventTime: Date.now(), text: 'Press embargo lifts at 9am on launch day.', epoch: 3,
    });
    assert.equal((await brain.ingest(afterBackup)).state, 'accepted');
    await brain.stop();

    const restored = await restoreBackup({ root, archive: backup.path });
    assert.equal(restored.ledger, 'live', 'the newer live ledger is kept');
    // The restored datastore has the fact again, until the gate replays the withdrawal.
    const raw = await gbrainDirect(root, 'search', { query: 'launch October' });
    assert.equal(raw.ok, true, `${raw.error}: ${raw.message}`);
    assert.ok(raw.value.some((hit) => hit.chunk_text?.includes('launch to 15 October')), 'the old backup does contain the fact');

    brain = await startLocalBrain({ root, binary });
    assert.ok(brain.readyInfo.timings.replay.purgedSlugs >= 1, JSON.stringify(brain.readyInfo.timings.replay));
    assert.equal(brain.readyInfo.timings.replay.lostPages, 1, 'the message ingested after the backup is known to be lost');
    const first = await brain.retrieve(retrievalRequest(PRIVATE, 'launch October'));
    assert.ok(!first.items.some((item) => item.evidenceId === fact.evidenceId), 'the first answer after restore does not have the withdrawn fact');
    const coverage = first.coverage.find((entry) => entry.source.id === ROOMS.launch);
    assert.equal(coverage.state, 'catching_up');
    assert.deepEqual(coverage.reasons, ['backfill_pending']);
    assert.equal(coverage.processedThrough, afterBackup.eventTime - 1, 'the reader rewinds to just before the lost message');
    const resent = await brain.ingest({ ...afterBackup, operationId: '00000000-0000-4000-8000-062d0a352c5e' });
    assert.equal(resent.state, 'accepted', 'the lost message is accepted again when the reader re-sends it');
    const embargo = await brain.retrieve(retrievalRequest(PRIVATE, 'embargo'));
    assert.equal(embargo.items.length, 1);
    await brain.stop();
    const direct = await gbrainDirect(root, 'search', { query: 'launch October' });
    assert.equal(direct.ok, true, `${direct.error}: ${direct.message}`);
    assert.ok(!direct.value.some((hit) => hit.chunk_text?.includes('launch to 15 October')), 'the replay purged the page in GBrain itself');
  });

  test('a backup whose ledger diverged from the live one is refused', async () => {
    const other = tempRoot();
    try {
      const brain = await startLocalBrain({ root: other, binary });
      const foreign = await brain.backup(join(backupDir, 'foreign.tar.gz'));
      await brain.stop();
      await assert.rejects(restoreBackup({ root, archive: foreign.path }), /not a continuation/);
    } finally {
      removeRoot(other);
    }
  });
});

describe('one owning process per brain', { skip: needBinary }, () => {
  let root;
  let brain;
  before(async () => {
    root = tempRoot();
    brain = await startLocalBrain({ root, binary });
  });
  after(async () => {
    await brain?.stop();
    removeRoot(root);
  });

  test('a second service on the same root is refused', async () => {
    await assert.rejects(startLocalBrain({ root, binary, timeoutMs: 60_000 }), /another local brain process|owner_lock_held/);
    assert.equal((await brain.info()).status, 'ready', 'the owner is undisturbed');
  });

  test('a binary that is not the expected one is refused before anything starts', async () => {
    const other = tempRoot();
    try {
      await assert.rejects(startLocalBrain({ root: other, binary, binarySha256: '0'.repeat(64) }), /exited before it was ready/);
      const signedDigest = startLocalBrain({ root: other, binary, binarySha256: pin.gbrain.assets[platformKey()].sha256 });
      await (await signedDigest).stop();
    } finally {
      removeRoot(other);
    }
  });

  test('GBrain refuses a second opener of the datastore while the service owns it', async () => {
    const direct = await gbrainDirect(root, 'list_pages', {});
    assert.equal(direct.ok, false, 'a second process must not open the live PGLite datastore');
  });

  test('a root inside a synced folder is refused', async () => {
    const synced = tempRoot('lb-synced-');
    try {
      writeFileSync(join(synced, '.sync_0123456789ab.db'), '');
      mkdirSync(join(synced, 'Atum'), { recursive: true });
      await assert.rejects(startLocalBrain({ root: join(synced, 'Atum', 'brain'), binary }), /synced|root_in_synced_folder/);
      const drive = tempRoot('lb-drive-');
      await assert.rejects(startLocalBrain({ root: join(drive, 'brain'), binary, forbidUnder: [drive] }), /synced|root_in_synced_folder/);
      removeRoot(drive);
    } finally {
      removeRoot(synced);
    }
  });

  test('an outage answers unavailable, never an empty success, and recovers', async () => {
    const info = await brain.info();
    process.kill(info.gbrain.pid, 'SIGKILL');
    const down = await brain.retrieve(retrievalRequest(PRIVATE, 'launch'));
    conforms('retrieval.response', down);
    assert.equal(down.status, 'unavailable');
    assert.deepEqual(down.items, []);
    await assert.rejects(brain.ingest(corpus().driveFile), (error) => error.code === -32001, 'an ingest during the outage is retryable, not lost');
    assert.ok(await waitFor(async () => (await brain.info()).status === 'ready', { timeoutMs: 60_000 }), 'the engine restarts');
    const up = await brain.retrieve(retrievalRequest(PRIVATE, 'launch'));
    assert.notEqual(up.status, 'unavailable');
  });
});

describe('the Google fence and the cloud import', { skip: needBinary }, () => {
  let root;
  let brain;
  const data = corpus();
  before(async () => {
    root = tempRoot();
    brain = await startLocalBrain({ root, binary });
    await ingestAll(brain, data);
  });
  after(async () => {
    await brain?.stop();
    removeRoot(root);
  });

  test('the fence is sticky, and the import holds back everything it covers', async () => {
    const info = await brain.info();
    assert.equal(info.fence.active, true, 'an envelope reporting the account fence sets it');
    const earlier = await brain.fence(contractFixture('fence-notice'));
    conforms('fence.ack', earlier);
    assert.equal(earlier.since, 1_790_240_400_000, 'an earlier notice moves the fence back, never forward');
    const fact = (await brain.retrieve(retrievalRequest(PRIVATE, 'launch October'))).items.find((item) => item.source.id === ROOMS.launch);
    await brain.withdraw(withdrawal({ kind: 'fact', evidenceId: fact.evidenceId }));
    const manifest = await brain.exportForCloud();
    assert.equal(manifest.format, 'atum.local-brain.import/1');
    assert.equal(manifest.withdrawals.length, 1, 'withdrawals travel first');
    assert.ok(manifest.envelopes.length >= 4);
    for (const env of manifest.envelopes) {
      assert.deepEqual(violations('envelope.managed', env), [], JSON.stringify(env));
      assert.notEqual(env.source.kind, 'drive_file', 'no Drive file leaves while the fence holds');
      assert.ok(!env.content.text.includes('invoices'), 'nothing Google-derived leaves the Mac');
      assert.ok(!env.content.text.includes('15 October'), 'nothing withdrawn is exported');
    }
    assert.equal(manifest.held.googleDerived, 1);
    assert.equal(manifest.held.fencedDrive, 1);
    assert.ok(!/"owner"\s*:/.test(JSON.stringify(manifest)), 'the manifest has no owner field: the managed service takes it from its channel');
    await brain.stop();
    brain = await startLocalBrain({ root, binary });
    assert.deepEqual((await brain.info()).fence, { active: true, since: 1_790_240_400_000 }, 'the fence survives a restart');
  });
});

describe('a crash in the middle of a swap, or a lost ledger', { skip: needBinary }, () => {
  test('a compaction interrupted between its renames is rolled back, and leftovers go', async () => {
    const root = tempRoot();
    try {
      let brain = await startLocalBrain({ root, binary });
      await brain.ingest(corpus().driveFile);
      await brain.stop();
      // As if the process died after moving the live datastore aside.
      renameSync(join(root, 'gbrain'), join(root, 'gbrain-retired-1-1'));
      mkdirSync(join(root, 'gbrain-next', 'brain.pglite'), { recursive: true });
      brain = await startLocalBrain({ root, binary });
      const recall = await brain.retrieve(retrievalRequest(PRIVATE, 'Q4 trial'));
      assert.equal(recall.items.length, 1, 'the old datastore is back in service');
      assert.ok(!existsSync(join(root, 'gbrain-next')) && !existsSync(join(root, 'gbrain-retired-1-1')));
      await brain.stop();
    } finally {
      removeRoot(root);
    }
  });

  test('a brain whose ledger is gone refuses to start, rather than forget its withdrawals', async () => {
    const root = tempRoot();
    try {
      const brain = await startLocalBrain({ root, binary });
      await brain.stop();
      rmSync(join(root, 'ledger', 'ledger.jsonl'));
      await assert.rejects(startLocalBrain({ root, binary }), /ledger_missing/);
    } finally {
      removeRoot(root);
    }
  });
});

describe('the datastore layout', { skip: needBinary }, () => {
  test('GBrain gets its own HOME and never touches the person\'s', () => {
    const paths = layout('/tmp/example-root');
    assert.equal(paths.gbrainUserHome, '/tmp/example-root/gbrain/home');
    assert.equal(paths.datastore, '/tmp/example-root/gbrain/brain.pglite');
  });
});
