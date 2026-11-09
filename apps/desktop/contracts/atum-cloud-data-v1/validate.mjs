#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const readJson = path => JSON.parse(readFileSync(join(root, path), "utf8"));
const requireInvariant = (condition, message) => {
  if (!condition) throw new Error(message);
};
const findForbidden = (value, forbidden, path = "$") => {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => findForbidden(child, forbidden, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [
      ...(forbidden.has(key) ? [`${path}.${key}`] : []),
      ...findForbidden(child, forbidden, `${path}.${key}`),
    ]);
  }
  return [];
};

const contract = readJson("contract.json");
requireInvariant(contract.contract_id === "atum.cloud-data", "wrong contract id");
requireInvariant(contract.version === 1 && contract.status === "frozen", "wrong version/status");
requireInvariant(contract.sync.change_id_type === "json_integer", "change_id type drifted");

const manifest = contract.pack_files;
requireInvariant(JSON.stringify(manifest) === JSON.stringify([...manifest].sort()), "pack_files must be sorted");
requireInvariant(new Set(manifest).size === manifest.length, "pack_files must be unique");
const digest = createHash("sha256");
for (const path of manifest) {
  const resolved = join(root, path);
  requireInvariant(!isAbsolute(path) && !relative(root, resolved).split(sep).includes(".."), "unsafe pack path");
  const name = Buffer.from(path);
  const body = readFileSync(resolved);
  const nameSize = Buffer.alloc(4);
  nameSize.writeUInt32BE(name.length);
  const bodySize = Buffer.alloc(8);
  bodySize.writeBigUInt64BE(BigInt(body.length));
  digest.update(nameSize).update(name).update(bodySize).update(body);
}

const fixturePaths = [...contract.fixtures.positive, ...contract.fixtures.adversarial];
const manifestFixtures = manifest.filter(path => path.startsWith("fixtures/"));
requireInvariant(JSON.stringify([...fixturePaths].sort()) === JSON.stringify([...manifestFixtures].sort()), "fixture manifest mismatch");

for (const path of [
  "fixtures/p2p-sync.response.json",
  "fixtures/app-history-sync.response.json",
  "fixtures/derived-invalidation-sync.response.json",
]) {
  const changes = readJson(path).changes;
  requireInvariant(changes.length > 0, `${path}: missing changes`);
  const ids = changes.map(change => change.change_id);
  requireInvariant(ids.every(id => Number.isSafeInteger(id) && id >= 1), `${path}: change_id must be a positive JSON integer`);
  requireInvariant(ids.every((id, index) => index === 0 || ids[index - 1] < id), `${path}: change_id order invalid`);
  for (const change of changes) {
    requireInvariant(contract.change_operations.includes(change.operation), `${path}: unknown operation`);
    const body = change.record ?? change.tombstone ?? change.invalidation;
    requireInvariant(body && typeof body === "object", `${path}: change body missing`);
    if (body.record_kind === "memory_fact") {
      requireInvariant(contract.sync.memory_fact_operations.includes(change.operation), `${path}: memory_fact content is retrieval-only`);
    }
    if (change.operation === "upsert") {
      requireInvariant(change.record.lifecycle === "active", `${path}: upsert must be active`);
      requireInvariant(change.record.untrusted_input === true, `${path}: upsert content must be untrusted`);
      requireInvariant(Boolean(change.record.occurred_at && change.record.recorded_at), `${path}: upsert timestamps missing`);
    } else if (change.operation === "tombstone") {
      requireInvariant(Object.keys(change.tombstone).every(key => contract.sync.tombstone_allowed_fields.includes(key)), `${path}: invalid tombstone fields`);
      requireInvariant(Object.keys(change.tombstone).length === contract.sync.tombstone_allowed_fields.length, `${path}: incomplete tombstone`);
      requireInvariant(change.tombstone.lifecycle === "deleted" && !("payload" in change.tombstone), `${path}: invalid tombstone`);
    } else {
      requireInvariant(Object.keys(change.invalidation).every(key => contract.sync.invalidation_allowed_fields.includes(key)), `${path}: invalid invalidation fields`);
      requireInvariant(Object.keys(change.invalidation).length === contract.sync.invalidation_allowed_fields.length, `${path}: incomplete invalidation`);
      requireInvariant(change.invalidation.lifecycle === "invalidated" && !("payload" in change.invalidation), `${path}: invalid invalidation`);
      requireInvariant(Boolean(change.invalidation.reason), `${path}: invalidation reason missing`);
    }
  }
}

const reset = readJson("fixtures/sync-cursor-expired.response.json").error;
requireInvariant(reset.code === contract.sync.reset_error_code && reset.reset === contract.sync.reset, "cursor reset drifted");

const ingest = readJson("fixtures/app-history-ingest.request.json");
requireInvariant(Object.keys(ingest).every(key => contract.app_history_ingest.allowed_request_fields.includes(key)), "unknown app-history request field");
requireInvariant(findForbidden(ingest, new Set(contract.server_owned_fields)).length === 0, "positive app-history request contains server authority");
requireInvariant(ingest.artifacts.every(artifact => Object.keys(artifact).every(key => contract.app_history_ingest.artifact_allowed_request_fields.includes(key))), "unknown artifact request field");
requireInvariant(ingest.artifacts.every(artifact => contract.artifact_copy_modes.includes(artifact.requested_copy_mode)), "invalid requested copy mode");
const ack = readJson("fixtures/app-history-ingest.response.json");
requireInvariant(ack.durability === "committed", "ingest ack preceded durable commit");
requireInvariant(ack.artifacts.every(artifact => contract.artifact_copy_modes.includes(artifact.effective_copy_mode)), "invalid effective copy mode");
requireInvariant(ack.artifacts.every(artifact => artifact.requested_copy_mode === artifact.effective_copy_mode || Boolean(artifact.copy_decision)), "copy-mode downgrade missing reason");
const forgedIngest = readJson("fixtures/app-history-forged-authority.request.json");
requireInvariant(findForbidden(forgedIngest, new Set(contract.server_owned_fields)).length > 0, "forged app-history authority was accepted");

const request = readJson("fixtures/retrieval-thread.request.json");
requireInvariant(Object.keys(request).every(key => contract.retrieval.allowed_request_fields.includes(key)), "unknown retrieval request field");
requireInvariant(request.max_items > 0 && request.max_items <= contract.retrieval.max_items, "requested item limit exceeded");
requireInvariant(request.max_content_utf8_bytes > 0 && request.max_content_utf8_bytes <= contract.retrieval.max_content_utf8_bytes, "requested byte limit exceeded");
requireInvariant(findForbidden(request, new Set(contract.retrieval.forbidden_request_fields)).length === 0, "positive retrieval request contains forbidden authority");
const forgedRequest = readJson("fixtures/retrieval-forged-authority.request.json");
requireInvariant(findForbidden(forgedRequest, new Set(contract.retrieval.forbidden_request_fields)).length > 0, "forged retrieval authority was accepted");

const validateBundle = bundle => {
  requireInvariant(bundle.fresh === true && !("next_cursor" in bundle), "v1 bundle is stale or has a continuation cursor");
  const contentBytes = bundle.items.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0);
  requireInvariant(bundle.content_utf8_bytes === contentBytes, "bundle byte count mismatch");
  requireInvariant(contentBytes <= contract.retrieval.max_content_utf8_bytes, "bundle byte limit exceeded");
  requireInvariant(bundle.items.length <= contract.retrieval.max_items, "bundle item limit exceeded");
  for (const item of bundle.items) {
    requireInvariant(item.source.lifecycle === "active", "bundle source must be explicitly active");
    requireInvariant(Boolean(item.source.occurred_at), "bundle source occurred_at missing");
    if (item.source.record_kind === "memory_fact") {
      requireInvariant(item.source.source_refs.length > 0 && item.source.source_refs.length <= contract.retrieval.max_sources_per_derived_item, "derived source fan-in invalid");
    }
  }
};
validateBundle(readJson("fixtures/retrieval-thread.response.json"));
const invalidated = readJson("fixtures/retrieval-invalidated-source.response.json");
let invalidatedRejected = false;
try {
  validateBundle(invalidated);
} catch {
  invalidatedRejected = true;
}
requireInvariant(invalidatedRejected, "invalidated retrieval source was accepted");

const actual = digest.digest("hex");
const expected = readFileSync(join(root, "PINNED-SHA256"), "utf8").trim();
requireInvariant(actual === expected, `pack checksum mismatch: expected ${expected}, got ${actual}`);
console.log(`CLOUD_DATA_V1_NODE_OK fixtures=${fixturePaths.length} sha256=${actual}`);
