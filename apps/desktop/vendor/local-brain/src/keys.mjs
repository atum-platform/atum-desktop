// Stable identifiers. Every device derives the same keys from the same source and
// object, so an evidence ID and a suppression agree across restarts, restores and a
// second device, and a withdrawal can name an object not yet seen here. (Which window
// page holds a message is this brain's own choice, recorded in its ledger.)

import { createHash } from 'node:crypto';

const hex = (text) => createHash('sha256').update(text).digest('hex');

/** RFC 4122 layout from 128 hash bits, with the version nibble set to 8 (custom). */
export function uuidFromHash(text) {
  const h = hex(text).slice(0, 32).split('');
  h[12] = '8';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export function sourceKey(source) {
  return [source.kind, source.id, source.agentPrincipal ?? ''].join('\u0000');
}

/** The logical object: an edit or redaction belongs to the object it replaces. */
export function logicalObjectId(object) {
  return object.replaces ?? object.id;
}

export function objectKey(source, logicalId) {
  return hex(`object\u0000${sourceKey(source)}\u0000${logicalId}`);
}

export function dedupKey(source, object) {
  return `${sourceKey(source)}\u0000${object.id}\u0000${object.revision}`;
}

export function evidenceIdFor(objectKeyValue) {
  return uuidFromHash(`evidence\u0000${objectKeyValue}`);
}

const ROOM_ID = /^![!-~]+$/;
const ROOM_SOURCES = new Set(['assistant_chat', 'human_dm', 'human_group', 'app_exchange']);

/** Conversation sources are scoped to their room; files, memory and statements are private. */
export function scopeFor(source) {
  if (ROOM_SOURCES.has(source.kind) && ROOM_ID.test(source.id)) return { kind: 'room', roomId: source.id };
  return { kind: 'private' };
}

/**
 * The GBrain page type that fences a scope. Retrieval for a room's audience passes it
 * as GBrain's `types` filter, so the search itself only ever sees that room's pages.
 */
export function scopeType(scope) {
  return scope.kind === 'room' ? `atum-r-${hex(`room\u0000${scope.roomId}`).slice(0, 24)}` : 'atum-p';
}

/**
 * A window's page (window.mjs): under its scope's prefix, named by a number unique for the
 * brain's life (the ledger sequence its first message was recorded at), so no window
 * ever takes the name of an older one.
 */
export function windowSlug(scope, id) {
  const segment = scope.kind === 'room' ? scopeType(scope).slice('atum-'.length) : 'p';
  return `atum/${segment}/w-${id}`;
}

export const REPLAY_SLUG = 'atum/sys/replay-watermark';

export function sha256Text(text) {
  return hex(text);
}
