/**
 * The device's own decisions on controller frames (`atum.device-service/1` §3.3), as pure
 * functions over the device's state, so the desktop device service (WS-3b `connection.ts`, WS-4
 * `service.ts`) and the conformance vectors share one implementation:
 *
 * - {@link admitGrant}: a `TurnGrant` is accepted (scopes intersected with local policy) or refused;
 * - {@link admitExecute}: the ten-step admission order on every `Execute`; any refusal leaves the
 *   ledger at `not_started`;
 * - {@link applyRenew}: a `Renew` extends authority by at most 15 s, never past the grant;
 * - {@link applyRevoke}: a delayed older `Revoke` can never undo a newer one;
 * - {@link verifyApproval}: an `ApproveRecord` is one use, for one command and capability, 60 s.
 *
 * Every function verifies the controller (or approval) signature itself against the keys the
 * device pinned at enrollment. Times are the device's receive times; the ±30 s skew allowance is
 * the contract's.
 */
import { DEVICE_SERVICE_PARAMETERS } from "./contract-packs";
import { verifyControllerEnvelope, verifyEs256 } from "./envelope";
import { argsHash, deviceMessageHash, deviceSignedBytes } from "./hashes";
import {
  toolCapability, type ApproveRecord, type B64u, type Capability, type DeviceRefusal, type Envelope, type Execute, type KeyId,
  type Ms, type ProtectedCapability, type Renew, type Revoke, type TurnGrant
} from "./messages";

/** What the device knows about itself and its current connection when a frame arrives. */
export interface DeviceAdmissionState {
  ownerUserId: string;
  deviceServiceId: string;
  enrollmentEpoch: number;
  accountEpoch: number;
  connectionId: string;
  connectionEpoch: number;
  signedIn: boolean;
  paused: boolean;
  localScopes: readonly Capability[];
  /** The owner's agents this device serves (their Matrix user IDs): every active agent of the owner,
   * cloud-answering or not. The field keeps its S1 name; an agent that is not the owner's is `wrong_agent`. */
  cloudAgents: readonly string[];
  pinnedControllerKeys: readonly KeyId[];
  controllerKeys: readonly { kid: KeyId; publicKey: B64u }[];
  /** The receive time of the frame, epoch ms. */
  receivedAt: Ms;
}

/** The device's local origin log entry, appended after the SDK acknowledged an owner send. */
export interface OriginLogEntry {
  assertionHash: B64u;
  roomId: string;
  eventId: string;
}

/**
 * A controller signature's two verdicts, independently: whether the kid is one the device pinned
 * at enrollment, and whether the key material the device holds for that kid verifies the frame.
 * Admission needs both (an unpinned kid is refused first, even with a good signature).
 */
export function controllerFrameFacts(device: Pick<DeviceAdmissionState, "pinnedControllerKeys" | "controllerKeys">, frame: Envelope): {
  kidPinned: boolean;
  signatureValid: boolean;
} {
  const kidPinned = device.pinnedControllerKeys.includes(frame.kid);
  const key = device.controllerKeys.find((entry) => entry.kid === frame.kid);
  return { kidPinned, signatureValid: !!key && verifyControllerEnvelope(frame, key.publicKey) };
}

function originMatches(device: DeviceAdmissionState, grant: TurnGrant, originLog: readonly OriginLogEntry[]): boolean {
  if (grant.originKind !== "device" || grant.targetDeviceServiceId !== device.deviceServiceId) return true;
  return originLog.some((entry) => entry.assertionHash === grant.originAssertionHash && entry.roomId === grant.roomId && entry.eventId === grant.eventId);
}

export type GrantDecision =
  | { outcome: "accepted"; effectiveScopes: Capability[] }
  | { outcome: "refused"; refusal: DeviceRefusal };

/** A `TurnGrant` on this device: accepted with the scopes local policy allows, or refused. */
export function admitGrant(device: DeviceAdmissionState, originLog: readonly OriginLogEntry[], frame: Envelope<"TurnGrant", TurnGrant>): GrantDecision {
  const refuse = (refusal: DeviceRefusal): GrantDecision => ({ outcome: "refused", refusal });
  const facts = controllerFrameFacts(device, frame);
  if (!facts.kidPinned) return refuse("unpinned_controller_key");
  if (!facts.signatureValid) return refuse("bad_signature");
  const grant = frame.body;
  if (!device.signedIn) return refuse("signed_out");
  if (grant.ownerUserId !== device.ownerUserId) return refuse("wrong_owner");
  if (grant.targetDeviceServiceId !== device.deviceServiceId) return refuse("wrong_device");
  if (!device.cloudAgents.includes(grant.agentUserId)) return refuse("wrong_agent");
  if (grant.connectionId !== device.connectionId) return refuse("stale_connection");
  if (grant.accountEpoch !== device.accountEpoch) return refuse("stale_account_epoch");
  if (grant.enrollmentEpoch !== device.enrollmentEpoch) return refuse("stale_enrollment");
  if (device.receivedAt > grant.expiresAt + DEVICE_SERVICE_PARAMETERS.skew_ms) return refuse("expired");
  if (!originMatches(device, grant, originLog)) return refuse("origin_not_mine");
  const effectiveScopes = grant.scopes.filter((scope) => device.localScopes.includes(scope));
  if (effectiveScopes.length === 0) return refuse("scope");
  return { outcome: "accepted", effectiveScopes };
}

/** A grant the device accepted, as it tracks it. */
export interface DeviceGrantState {
  body: TurnGrant;
  status: "live" | "stopped" | "revoked";
  /** The last admitted `seq` (0 before the first). */
  lastSeq: number;
  effectiveScopes: readonly Capability[];
  /** Authority lapses after this (renewed by `Renew`), epoch ms. */
  authorityUntil: Ms;
}

export interface StandingGrant {
  capability: ProtectedCapability;
  /** `*` covers every target; otherwise the exact target `targetOf` names. */
  target: string;
}

export type ExecuteDecision =
  | { outcome: "admitted"; commandHash: B64u; capabilities: ProtectedCapability[] }
  | { outcome: "duplicate"; commandHash: B64u }
  | { outcome: "needs_approval"; commandHash: B64u; capabilities: ProtectedCapability[] }
  | { outcome: "refused"; commandHash: B64u; refusal: DeviceRefusal };

export interface ExecuteAdmissionInput {
  device: DeviceAdmissionState;
  /** The grant the Execute names, or null when the device holds no such grant. */
  grant: DeviceGrantState | null;
  /** Commands this device has seen in the dedupe window, by ID and hash. */
  seen: readonly { commandId: string; commandHash: B64u }[];
  originLog: readonly OriginLogEntry[];
  standingGrants: readonly StandingGrant[];
  execute: Envelope<"Execute", Execute>;
  /** The device's own effect classification (WS-4 `policy.ts`); added to `needs` and the proposal. */
  classify?(execute: Execute): readonly ProtectedCapability[];
  /** The target a standing grant must name for this command and capability (default: only `*` covers). */
  targetOf?(execute: Execute, capability: ProtectedCapability): string | null;
  /** Approvals already verified for this exact command (one use each). */
  approved?: readonly ProtectedCapability[];
}

/**
 * The admission order on every `Execute` (§3.3): controller key pinned and signature valid;
 * signed in; this device, connection and epochs; grant live; a duplicate returns the stored
 * receipt and a different payload under the same ID is refused; `seq` exactly the next; the
 * `argsHash` recomputed; within `admitBy` (±30 s) and the grant's renewed authority; the origin
 * bound to the local origin log; scope; the GUI refused while paused; and a protected effect
 * needs a standing grant or a fresh approval.
 */
export function admitExecute(input: ExecuteAdmissionInput): ExecuteDecision {
  const { device, grant, execute: frame } = input;
  const command = frame.body;
  let commandHash: B64u;
  try {
    commandHash = deviceMessageHash("Execute", command);
  } catch {
    // A body canonical JSON refuses (a float, a lone surrogate) was never signed by anyone.
    return { outcome: "refused", commandHash: "", refusal: "bad_signature" };
  }
  const refuse = (refusal: DeviceRefusal): ExecuteDecision => ({ outcome: "refused", commandHash, refusal });
  const facts = controllerFrameFacts(device, frame);
  if (!facts.kidPinned) return refuse("unpinned_controller_key");
  if (!facts.signatureValid) return refuse("bad_signature");
  if (!device.signedIn) return refuse("signed_out");
  if (command.deviceServiceId !== device.deviceServiceId) return refuse("wrong_device");
  if (command.connectionId !== device.connectionId || command.connectionEpoch !== device.connectionEpoch) return refuse("stale_connection");
  if (command.accountEpoch !== device.accountEpoch) return refuse("stale_account_epoch");
  if (command.enrollmentEpoch !== device.enrollmentEpoch) return refuse("stale_enrollment");
  if (!grant || grant.body.grantId !== command.grantId || grant.status !== "live") return refuse("stopped");
  const seen = input.seen.find((entry) => entry.commandId === command.commandId);
  if (seen) return seen.commandHash === commandHash ? { outcome: "duplicate", commandHash } : refuse("replayed");
  if (command.seq <= grant.lastSeq) return refuse("replayed");
  if (command.seq !== grant.lastSeq + 1) return refuse("seq_gap");
  let recomputed: string;
  try {
    recomputed = argsHash(command.args);
  } catch {
    return refuse("args_hash_mismatch");
  }
  if (recomputed !== command.argsHash) return refuse("args_hash_mismatch");
  const skew = DEVICE_SERVICE_PARAMETERS.skew_ms;
  if (device.receivedAt > command.admitBy + skew || device.receivedAt > grant.authorityUntil ||
      device.receivedAt > grant.body.expiresAt + skew) return refuse("expired");
  if (!originMatches(device, grant.body, input.originLog)) return refuse("origin_not_mine");
  const capability = toolCapability(command.tool);
  if (!grant.effectiveScopes.includes(capability) || !device.localScopes.includes(capability)) return refuse("scope");
  if (command.tool === "computer_use" && device.paused) return refuse("paused");
  const proposed = command.proposedEffect === "ordinary" ? [] : [command.proposedEffect];
  const capabilities = [...new Set([...command.needs, ...proposed, ...(input.classify?.(command) ?? [])])];
  const uncovered = capabilities.filter((needed) => !(input.approved ?? []).includes(needed) && !input.standingGrants.some((standing) =>
    standing.capability === needed && (standing.target === "*" || standing.target === input.targetOf?.(command, needed))));
  if (uncovered.length) return { outcome: "needs_approval", commandHash, capabilities: uncovered };
  return { outcome: "admitted", commandHash, capabilities };
}

export type RenewDecision =
  | { outcome: "extended"; authorityUntil: Ms }
  | { outcome: "ignored"; reason: "bad_signature" | "unpinned_controller_key" | "stopped" | "past_grant" | "window" | "unknown_grant" };

/** A `Renew`: authority until `until`, which may be at most 15 s ahead and never past the grant. */
export function applyRenew(device: DeviceAdmissionState, grant: Pick<DeviceGrantState, "body" | "status"> | null, frame: Envelope<"Renew", Renew>): RenewDecision {
  const facts = controllerFrameFacts(device, frame);
  if (!facts.kidPinned) return { outcome: "ignored", reason: "unpinned_controller_key" };
  if (!facts.signatureValid) return { outcome: "ignored", reason: "bad_signature" };
  if (!grant || grant.body.grantId !== frame.body.grantId) return { outcome: "ignored", reason: "unknown_grant" };
  if (grant.status !== "live") return { outcome: "ignored", reason: "stopped" };
  if (frame.body.until > grant.body.expiresAt) return { outcome: "ignored", reason: "past_grant" };
  if (frame.body.until > device.receivedAt + DEVICE_SERVICE_PARAMETERS.authority_window_ms) return { outcome: "ignored", reason: "window" };
  return { outcome: "extended", authorityUntil: frame.body.until };
}

export type RevokeDecision =
  | { outcome: "applied" }
  | { outcome: "ignored"; reason: "bad_signature" | "unpinned_controller_key" | "wrong_device" | "other_epoch" | "older_revoke" };

/** A `Revoke` of this device's enrollment epoch, applied only when newer than the last one. */
export function applyRevoke(device: DeviceAdmissionState, lastRevokeSeq: number, frame: Envelope<"Revoke", Revoke>): RevokeDecision {
  const facts = controllerFrameFacts(device, frame);
  if (!facts.kidPinned) return { outcome: "ignored", reason: "unpinned_controller_key" };
  if (!facts.signatureValid) return { outcome: "ignored", reason: "bad_signature" };
  if (frame.body.deviceServiceId !== device.deviceServiceId) return { outcome: "ignored", reason: "wrong_device" };
  if (frame.body.enrollmentEpoch !== device.enrollmentEpoch) return { outcome: "ignored", reason: "other_epoch" };
  if (frame.body.revokeSeq <= lastRevokeSeq) return { outcome: "ignored", reason: "older_revoke" };
  return { outcome: "applied" };
}

export type ApprovalDecision =
  | { outcome: "valid"; approvalHash: B64u }
  | { outcome: "invalid"; reason: "bad_signature" | "wrong_key" | "wrong_device" | "stale_account_epoch" | "wrong_command" | "wrong_capability" | "expired" | "used" | "window" };

/** The device-local approval frame (never on the wire), signed by the approval key. */
export interface ApproveFrame {
  v: 1;
  type: "Approve";
  body: ApproveRecord;
  kid: KeyId;
  sig: B64u;
}

export interface ApprovalInput {
  device: { deviceServiceId: string; accountEpoch: number; approvalKey: { kid: KeyId; publicKey: B64u }; usedNonces: readonly string[]; now: Ms };
  commandHash: B64u;
  capability: ProtectedCapability;
  approve: ApproveFrame;
}

/** An approval-key-signed `ApproveRecord` for exactly this command and capability, unused, unexpired. */
export function verifyApproval(input: ApprovalInput): ApprovalDecision {
  const { device, approve } = input;
  const record = approve.body;
  const invalid = (reason: Extract<ApprovalDecision, { outcome: "invalid" }>["reason"]): ApprovalDecision => ({ outcome: "invalid", reason });
  if (approve.kid !== device.approvalKey.kid) return invalid("wrong_key");
  if (!verifyEs256(device.approvalKey.publicKey, deviceSignedBytes("Approve", record), approve.sig)) return invalid("bad_signature");
  if (record.deviceServiceId !== device.deviceServiceId) return invalid("wrong_device");
  if (record.accountEpoch !== device.accountEpoch) return invalid("stale_account_epoch");
  if (record.commandHash !== input.commandHash) return invalid("wrong_command");
  if (record.capability !== input.capability) return invalid("wrong_capability");
  if (record.expiresAt - record.createdAt > DEVICE_SERVICE_PARAMETERS.approval_ms || record.expiresAt < record.createdAt) return invalid("window");
  if (device.now > record.expiresAt) return invalid("expired");
  if (device.usedNonces.includes(record.nonce)) return invalid("used");
  return { outcome: "valid", approvalHash: deviceMessageHash("Approve", record) };
}
