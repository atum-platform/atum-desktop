/**
 * Origin assertions (`atum.cloud-answering/1` §3.2). A Mac's device service signs, with its
 * Secure Enclave identity key, an assertion that rides inside the owner's message content under
 * `io.atum.origin` (Megolm-encrypted in an encrypted room, plain in a room without encryption).
 * The controller accepts the Mac as the turn's origin only when
 * the assertion arrived in a verified owner-device event **and** matches the DA registry, so a
 * platform compromise alone cannot substitute a device key.
 *
 * {@link verifyOrigin} is the verification order as a pure function; the controller's
 * `OriginVerifier` supplies the registry and its persisted nonce set.
 */
import { CLOUD_ANSWERING_PACK, CLOUD_ANSWERING_PARAMETERS } from "./contract-packs";
import { verifyOriginSignature } from "./envelope";
import { ORIGIN_CONTENT_KEY, originAssertionHash, requestDigestV2 } from "./hashes";
import type { B64u, KeyId } from "./messages";
import { messageViolations } from "./schema";

/** The assertion's wire shape (the frozen `origin_assertion` type). */
export interface OriginAssertionV1 {
  v: 1;
  dsid: string;
  kid: KeyId;
  ee: number;
  ae: number;
  boot: string;
  n: B64u;
  t: number;
  owner: string;
  agent: string;
  room: string;
  dev: string;
  fpr: string;
  dg: B64u;
  sig: B64u;
}

export type OriginInvalidReason =
  | "malformed" | "sender_not_owner" | "sender_unverified" | "wrong_owner" | "wrong_agent" | "wrong_room"
  | "device_mismatch" | "fingerprint_mismatch" | "unknown_device_service" | "key_mismatch" | "stale_enrollment"
  | "binding_mismatch" | "bad_signature" | "digest_mismatch" | "clock_skew" | "replayed";

export type OriginDecision =
  | { kind: "device"; deviceServiceId: string; assertionHash: B64u; assertion: OriginAssertionV1 }
  | { kind: "other" }
  | { kind: "invalid"; reason: OriginInvalidReason };

/** The owner message as the controller reads it (the SDK projection, or a conformance case). */
export interface OriginMessage {
  roomId: string;
  eventId: string;
  sender: string;
  senderDevice?: string;
  senderVerified: boolean;
  senderFingerprint?: string;
  /** The event's `origin_server_ts`. */
  originServerTs: number;
  /** The assertion as read from the decrypted content (`io.atum.origin`), if any. */
  assertion: unknown;
  /** Request digest v2 over the raw decrypted content (the SDK computes it before projecting). */
  contentDigest: string | undefined;
  /**
   * The verifier's own SDK read the event as a plain `m.room.message` in a room without
   * encryption. There is no sending Matrix device to compare, so only the device and fingerprint
   * comparisons are skipped; the registry binding, signature, digest, time window and nonce
   * still apply, and the Mac's own log of what it sent binds the exact event.
   *
   * Taken from the reader's own decision about the room (its synced state and its crypto store
   * both), never from how the event arrived: see `wireType`.
   */
  plain?: boolean;
  /**
   * The event's wire type as the verifier's own SDK read it. It must agree with `plain`: a plain
   * read is an `m.room.message`, and any other read is an `m.room.encrypted` (when given). A plain
   * read without it, or a disagreement, is refused as `sender_unverified`: a plaintext event in a
   * room that is not plain never skips the device comparisons (no downgrade).
   */
  wireType?: string;
}

/** A registry entry the controller holds for the owner (DA `devices.list`, active services). */
export interface OriginRegistryEntry {
  deviceServiceId: string;
  identityKey: B64u;
  identityKeyId: KeyId;
  enrollmentEpoch: number;
  matrixDeviceId: string;
  matrixFingerprint: string;
  state: "active" | "revoked";
}

export interface OriginInput {
  message: OriginMessage;
  assignment: { ownerUserId: string; agentUserId: string };
  registry: readonly OriginRegistryEntry[];
  /**
   * Whether this nonce was already seen for this device service within the 7-day window bound
   * to a different event. Re-verifying the same event (on recovery, or when the queued turn
   * runs) is not a replay.
   */
  nonceSeen(deviceServiceId: string, nonce: string, binding: { roomId: string; eventId: string; assertionHash: B64u }): boolean;
}

/** The assertion's violations against the frozen `origin.assertion` schema. */
export function originAssertionViolations(value: unknown) {
  return messageViolations(CLOUD_ANSWERING_PACK, "origin.assertion", value);
}

/** The assertion hash: unpadded base64url SHA-256 of the origin signing input (without `sig`). */
export function assertionHashOf(assertion: OriginAssertionV1): B64u {
  const { sig: _sig, ...rest } = assertion;
  return originAssertionHash(rest);
}

/**
 * The verification order: (1) a well-formed assertion; (2) the sender is the owner on a verified
 * device, and the assertion names that owner, this agent and this room; (3) the sender's Matrix
 * device and fingerprint are the assertion's; (4) the registry has this active device service with
 * this identity key, enrollment epoch and Matrix binding; (5) the signature; (6) the request digest;
 * (7) |t − origin_server_ts| ≤ 300 s; (8) the nonce is fresh for this device in the last 7 days.
 * No assertion at all is origin `other` (phone, web, or a Mac without the device service).
 */
export function verifyOrigin(input: OriginInput): OriginDecision {
  const { message, assignment } = input;
  if (message.assertion === undefined || message.assertion === null) return { kind: "other" };
  const invalid = (reason: OriginInvalidReason): OriginDecision => ({ kind: "invalid", reason });
  if (originAssertionViolations(message.assertion).length) return invalid("malformed");
  const assertion = message.assertion as OriginAssertionV1;
  if (message.sender !== assignment.ownerUserId) return invalid("sender_not_owner");
  if (!message.senderVerified) return invalid("sender_unverified");
  if (message.plain === true ? message.wireType !== "m.room.message"
    : message.wireType !== undefined && message.wireType !== "m.room.encrypted") return invalid("sender_unverified");
  if (assertion.owner !== message.sender) return invalid("wrong_owner");
  if (assertion.agent !== assignment.agentUserId) return invalid("wrong_agent");
  if (assertion.room !== message.roomId) return invalid("wrong_room");
  if (message.plain !== true && message.senderDevice !== assertion.dev) return invalid("device_mismatch");
  if (message.plain !== true && message.senderFingerprint !== assertion.fpr) return invalid("fingerprint_mismatch");
  const entry = input.registry.find((candidate) => candidate.deviceServiceId === assertion.dsid && candidate.state === "active");
  if (!entry) return invalid("unknown_device_service");
  if (entry.identityKeyId !== assertion.kid) return invalid("key_mismatch");
  if (entry.enrollmentEpoch !== assertion.ee) return invalid("stale_enrollment");
  if (entry.matrixDeviceId !== assertion.dev || entry.matrixFingerprint !== assertion.fpr) return invalid("binding_mismatch");
  if (!verifyOriginSignature(assertion as unknown as Record<string, unknown>, entry.identityKey)) return invalid("bad_signature");
  if (!message.contentDigest || message.contentDigest !== assertion.dg) return invalid("digest_mismatch");
  if (Math.abs(assertion.t - message.originServerTs) > CLOUD_ANSWERING_PARAMETERS.origin_skew_ms) return invalid("clock_skew");
  const assertionHash = assertionHashOf(assertion);
  if (input.nonceSeen(assertion.dsid, assertion.n, { roomId: message.roomId, eventId: message.eventId, assertionHash })) return invalid("replayed");
  return { kind: "device", deviceServiceId: assertion.dsid, assertionHash, assertion };
}

/** The request digest of a raw decrypted content (the conformance cases carry the raw content). */
export function contentDigestOf(content: Record<string, unknown>): string | undefined {
  try {
    return requestDigestV2(content);
  } catch {
    return undefined;
  }
}

/** The raw assertion inside a decrypted content, if present. */
export function assertionOf(content: Record<string, unknown>): unknown {
  return Object.hasOwn(content, ORIGIN_CONTENT_KEY) ? content[ORIGIN_CONTENT_KEY] : undefined;
}

/** The nonce window, ms (7 days). */
export const ORIGIN_NONCE_WINDOW_MS = CLOUD_ANSWERING_PARAMETERS.nonce_window_days * 24 * 60 * 60 * 1000;
