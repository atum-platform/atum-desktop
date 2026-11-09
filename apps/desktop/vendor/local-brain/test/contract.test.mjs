import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTRACT, CONTRACT_ID, machineViolations, violations } from '../src/contract.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendored = join(packageRoot, 'contract', 'awareness-v1');
const repoSpec = join(packageRoot, '..', '..', 'spec', 'awareness', 'v1');

test('the vendored contract is atum.awareness/1', () => {
  assert.equal(CONTRACT_ID, 'atum.awareness/1');
  assert.equal(CONTRACT.status, 'frozen');
});

test('the vendored pack records an immutable source and verifies every declared byte', () => {
  const source = JSON.parse(readFileSync(join(vendored, 'SOURCE.json'), 'utf8'));
  assert.equal(source.source.repository, 'atum-platform');
  assert.equal(source.source.branch, 'main');
  assert.match(source.source.commit, /^[a-f0-9]{40}$/);
  assert.match(source.source.packDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(CONTRACT.pack_files, [...CONTRACT.pack_files].sort());
  const digest = createHash('sha256');
  for (const file of CONTRACT.pack_files) {
    assert.ok(existsSync(join(vendored, file)), `${file} is missing from the vendored pack`);
    const encoded = Buffer.from(file, 'utf8');
    const body = readFileSync(join(vendored, file));
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(encoded.length);
    const bodyLength = Buffer.alloc(8);
    bodyLength.writeBigUInt64BE(BigInt(body.length));
    digest.update(pathLength).update(encoded).update(bodyLength).update(body);
  }
  assert.equal(digest.digest('hex'), source.source.packDigest);
  assert.equal(readFileSync(join(vendored, 'PINNED-SHA256'), 'utf8').trim(), source.source.packDigest);
});

test('the vendored copy matches spec/awareness/v1 byte for byte once the pack is in the tree', (t) => {
  if (!existsSync(join(repoSpec, 'contract.json'))) {
    t.skip('spec/awareness/v1 is not in this tree yet (atum-platform PR #404)');
    return;
  }
  for (const file of CONTRACT.pack_files) {
    assert.deepEqual(readFileSync(join(vendored, file)), readFileSync(join(repoSpec, file)), `${file} drifted from the spec`);
  }
});

test('the runtime checker gives every fixture the verdict the contract declares', () => {
  for (const entry of CONTRACT.fixtures) {
    const body = JSON.parse(readFileSync(join(vendored, entry.file), 'utf8'));
    const found = entry.message ? violations(entry.message, body) : machineViolations(entry.machine, body.steps);
    if (entry.expect === 'accept') {
      assert.deepEqual(found, [], `${entry.file} should be accepted`);
    } else {
      const categories = new Set(found.map(([category]) => category));
      assert.ok(categories.has(entry.violation), `${entry.file} should be rejected for ${entry.violation}, got ${JSON.stringify(found)}`);
    }
  }
});

test('forbidden fields are found at any depth', () => {
  const found = violations('recall.tool_args', { query: 'x', filters: { audience: 'private_owner' } });
  assert.ok(found.some(([category, path]) => category === 'forbidden_field' && path === '$.filters.audience'));
});
