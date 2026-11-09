/**
 * Device-service 1.1 wire types consumed from the approved, pinned contract pack.
 * Runtime validation uses the complete vendored schema and invariants; the
 * TypeScript shapes describe the same messages without modifying that contract.
 */

import { CHATGPT_RELAY_PACK, DEVICE_SERVICE_PACK, DEVICE_WORKSPACE_PACK } from "./contract-packs";
import type { WorkspaceMessageBodies } from "./workspace-messages";
import type { MigrationMessageBodies } from "./migration-messages";
import { messageViolations, type Violation } from "./schema";
import { parseStrictJson, StrictJsonError } from "./strict-json";

export type B64u = string;
export type KeyId = string;
export type Ms = number;
export type Uuid = string;

export const CAPABILITIES = ["terminal", "files", "computer", "send_file"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const PROTECTED_CAPABILITIES = [
  "ssh_agent", "keychain", "browser_store", "cloud_cli", "persistence", "network_new_host",
  "sudo", "other_agent_write", "exec_downloaded", "bulk_destructive", "gui_upload",
] as const;
export type ProtectedCapability = (typeof PROTECTED_CAPABILITIES)[number];

export const LEDGER_STATES = ["not_started", "started", "completed", "failed_no_effect", "unknown", "refused"] as const;
export type LedgerState = (typeof LEDGER_STATES)[number];

export const DEVICE_REFUSALS = [
  "wrong_owner", "wrong_agent", "wrong_device", "stale_enrollment", "stale_account_epoch", "stale_connection",
  "bad_signature", "unpinned_controller_key", "expired", "replayed", "seq_gap", "args_hash_mismatch",
  "origin_not_mine", "scope", "protected_needs_approval", "approval_denied", "approval_timeout", "stopped",
  "signed_out", "rate_limited", "paused",
] as const;
export type DeviceRefusal = (typeof DEVICE_REFUSALS)[number];

export const DEVICE_MESSAGE_TYPES = [
  "Hello", "Challenge", "Proof", "Ready", "TurnGrant", "GrantAck", "Execute", "Renew", "Receipt",
  "StatusQuery", "Status", "Cancel", "Revoke", "Stop", "OriginReceipt",
  "MigrationOffer", "MigrationRequest", "MigrationDecline", "MigrationAck", "MigrationReport",
  "MigrationChoose", "MigrationCancel", "MigrationResult",
  "WorkspaceFinalize", "WorkspaceResult", "WorkspaceConfirm", "WorkspaceRefused",
  "ChatGptRelayRequest", "ChatGptRelayResponse",
] as const;
export type DeviceMessageType = (typeof DEVICE_MESSAGE_TYPES)[number];

export const DEVICE_TOOLS = ["terminal", "read_file", "write_file", "patch", "search_files", "computer_use", "send_file"] as const;
export type DeviceTool = (typeof DEVICE_TOOLS)[number];

/** Frozen timings (S1 build plan §3.3). */
export const DEVICE_SERVICE_TIMINGS = {
  admissionMs: 15_000, approvalMs: 60_000, heartbeatMs: 5_000, authorityWindowMs: 15_000, clockSkewMs: 30_000,
  dedupeDays: 7, grantMaxMs: 1_800_000, preauthMs: 10_000,
} as const;
export const DEVICE_HUB_URL = "wss://devices.atumplatform.com/v1" as const;
export const DEVICE_HUB_MAX_PAYLOAD_BYTES = 1_048_576;

/** The signed envelope every frame travels in. `kid` is the signer; `sig` is over the signed bytes. */
export interface Envelope<T extends DeviceMessageType = DeviceMessageType, B = unknown> {
  v: 1;
  type: T;
  body: B;
  kid: KeyId;
  sig: B64u;
}

export interface Hello {
  workspaceProtocol?: 1;
  deviceServiceId: Uuid;
  enrollmentEpoch: number;
  accountEpoch: number;
  bootId: string;
  connectionNonce: B64u;
  policyVersion: number;
  appVersion: string;
  matrixDeviceId: string;
  capabilities: { terminal: boolean; files: boolean; computer: { available: boolean; reason?: string } };
  sentAt: Ms;
}
export interface Challenge { connectionId: Uuid; challenge: B64u; helloHash: B64u; issuedAt: Ms }
export interface Proof { connectionId: Uuid; challenge: B64u; helloHash: B64u }
export interface Ready { workspaceProtocol?: 1; connectionId: Uuid; connectionEpoch: number; heartbeatMs: 5000; serverTime: Ms }

export interface TurnGrant {
  grantId: Uuid;
  ownerUserId: string;
  agentPrincipal: Uuid;
  agentUserId: string;
  invocationId?: Uuid;
  occurrenceId?: Uuid;
  roomId?: string;
  eventId?: string;
  originKind: "device" | "other" | "schedule";
  originAssertionHash: B64u | null;
  writerEpoch: { leaseGeneration: number; leaseTokenHash: B64u };
  targetDeviceServiceId: Uuid;
  enrollmentEpoch: number;
  accountEpoch: number;
  scopes: Capability[];
  connectionId: Uuid;
  issuedAt: Ms;
  expiresAt: Ms;
}
export interface GrantAck { grantId: Uuid; accepted: boolean; refusal?: DeviceRefusal; effectiveScopes: Capability[] }

export interface Execute {
  commandId: Uuid;
  grantId: Uuid;
  seq: number;
  connectionId: Uuid;
  connectionEpoch: number;
  deviceServiceId: Uuid;
  enrollmentEpoch: number;
  accountEpoch: number;
  tool: DeviceTool;
  toolVersion: 1;
  args: Record<string, unknown>;
  argsHash: B64u;
  inputManifestHash: B64u | null;
  needs: ProtectedCapability[];
  proposedEffect: "ordinary" | ProtectedCapability;
  admitBy: Ms;
  timeoutMs: number;
  issuedAt: Ms;
}
export interface Renew { grantId: Uuid; until: Ms }
export interface ReceiptArtifact { name: string; size: number; sha256: B64u }
export interface Receipt {
  commandId: Uuid;
  commandHash: B64u;
  seq: number;
  state: LedgerState;
  refusal?: DeviceRefusal;
  result?: { exitCode?: number; output?: string; data?: unknown };
  artifacts: ReceiptArtifact[];
  approvalHash?: B64u;
  startedAt?: Ms;
  endedAt?: Ms;
}
export interface StatusQuery { commandIds: Uuid[] }
export interface Status { receipts: Receipt[] }
export interface Cancel { grantId: Uuid; commandId?: Uuid; reason: "turn_stopped" | "lease_lost" | "superseded" }
export interface Revoke { deviceServiceId: Uuid; enrollmentEpoch: number; revokeSeq: number }
export interface Stop { reason: "local_stop" | "sign_out" | "account_switch" | "sleep"; accountEpoch: number; grantIds: Uuid[] }
export interface OriginReceipt { assertionHash: B64u; roomId: string; eventId: string }
export interface ChatGptRelayRequest {
  capabilityId: Uuid; ownerPrincipal: Uuid; agentPrincipal: Uuid; invocationId: Uuid;
  model: string; effort: "low" | "medium" | "high"; relayRevision: number; deviceServiceId: Uuid;
  connectionId: Uuid; connectionEpoch: number; issuedAt: Ms; expiresAt: Ms;
  maxResponseBytes: number; requestBytes: number; requestJson: string;
}
export type ChatGptRelayResponse =
  | { capabilityId: Uuid; state: "completed"; status: 200; responseJson: string }
  | { capabilityId: Uuid; state: "refused"; status: number; code: string };
/** An approval record is created only on the device and never travels on the wire. */
export interface ApproveRecord {
  deviceServiceId: Uuid;
  accountEpoch: number;
  commandHash: B64u;
  capability: ProtectedCapability;
  target: string;
  destination?: string;
  createdAt: Ms;
  expiresAt: Ms;
  nonce: B64u;
}

export interface MessageBodies extends MigrationMessageBodies, WorkspaceMessageBodies {
  Hello: Hello; Challenge: Challenge; Proof: Proof; Ready: Ready; TurnGrant: TurnGrant; GrantAck: GrantAck;
  Execute: Execute; Renew: Renew; Receipt: Receipt; StatusQuery: StatusQuery; Status: Status; Cancel: Cancel;
  Revoke: Revoke; Stop: Stop; OriginReceipt: OriginReceipt;
  ChatGptRelayRequest: ChatGptRelayRequest; ChatGptRelayResponse: ChatGptRelayResponse;
}

/** The controller signs with Ed25519; the device signs ES256 (P-256) via the Secure Enclave. */
export const ENVELOPE_SIGNERS: Record<DeviceMessageType, "device" | "controller"> = {
  WorkspaceFinalize: "controller", WorkspaceConfirm: "controller", WorkspaceResult: "device", WorkspaceRefused: "device",
  Hello: "device", Proof: "device", GrantAck: "device", Receipt: "device", Status: "device", Stop: "device",
  OriginReceipt: "device", Challenge: "controller", Ready: "controller", TurnGrant: "controller", Execute: "controller",
  Renew: "controller", StatusQuery: "controller", Cancel: "controller", Revoke: "controller",
  MigrationOffer: "device", MigrationRequest: "controller", MigrationDecline: "device", MigrationAck: "controller",
  MigrationReport: "controller", MigrationChoose: "device", MigrationCancel: "device", MigrationResult: "controller",
  ChatGptRelayRequest: "controller", ChatGptRelayResponse: "device",
};

// --------------------------------------------------------------- runtime validators (WS-3a)
//
// The type surface above is frozen. Every frame is validated against the vendored, pinned
// device-service pack (`./contract-packs`) by the same rules as the platform's reference checker:
// shape and bounds, the direction's forbidden fields anywhere in the frame, and the pack's
// invariants (an Execute admits within 15 s of issue, a grant lives at most 30 min, an approval at
// most 60 s). Frames are parsed with strict JSON. Signatures are checked separately
// (`./envelope`), because which key may sign depends on the receiver's state.

export class DeviceProtocolError extends Error {
  constructor(message: string, readonly violations: readonly Violation[] = []) {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Every frame type the contract defines, including the device-local `Approve`. */
export const FRAME_TYPES = [...DEVICE_MESSAGE_TYPES, "Approve"] as const;
export type FrameType = (typeof FRAME_TYPES)[number];

export type FrameDirection = "device_to_controller" | "controller_to_device" | "device_local";

/** Which way a frame type travels (the pack's `direction`). */
export function frameDirection(type: FrameType): FrameDirection {
  return (CHATGPT_RELAY_PACK.messages[`frame.${type}`] ?? DEVICE_WORKSPACE_PACK.messages[`frame.${type}`]
    ?? DEVICE_SERVICE_PACK.messages[`frame.${type}`])!.direction as FrameDirection;
}

/** Every violation of `value` as a frame of its own `type` (an unknown type is one violation). */
export function frameViolations(value: unknown): Violation[] {
  if (!isObject(value) || typeof value.type !== "string" || !(FRAME_TYPES as readonly string[]).includes(value.type)) {
    return [{ category: isObject(value) ? "enum" : "type", path: isObject(value) ? "$.type" : "$" }];
  }
  const relay = value.type.startsWith("ChatGptRelay");
  const extension = value.type.startsWith("Workspace") || ((value.type === "Hello" || value.type === "Ready")
    && isObject(value.body) && value.body.workspaceProtocol !== undefined);
  return messageViolations(relay ? CHATGPT_RELAY_PACK : extension ? DEVICE_WORKSPACE_PACK : DEVICE_SERVICE_PACK,
    `frame.${value.type}`, value);
}

/** Every violation of `value` as the device-service pack's message `name` (routes, cases, vectors). */
export function deviceServiceViolations(name: string, value: unknown): Violation[] {
  return messageViolations(DEVICE_SERVICE_PACK, name, value);
}

/**
 * A validated wire envelope (`Approve` never travels). Throws
 * {@link DeviceProtocolError} `device_envelope_invalid` with the violations. When `direction` is
 * given, a frame travelling the other way is refused too (`device_envelope_direction`).
 */
export function parseEnvelope(value: unknown, direction?: Exclude<FrameDirection, "device_local">): Envelope {
  const violations = frameViolations(value);
  const type = isObject(value) ? value.type : undefined;
  if (violations.length === 0 && type === "Approve") violations.push({ category: "enum", path: "$.type" });
  if (violations.length) throw new DeviceProtocolError("device_envelope_invalid", violations);
  if (direction && frameDirection(type as FrameType) !== direction) throw new DeviceProtocolError("device_envelope_direction");
  return value as unknown as Envelope;
}

/** Strict-JSON parse and validate one text frame (at most the hub's 1 MiB payload). */
export function parseFrame(text: string, direction?: Exclude<FrameDirection, "device_local">): Envelope {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > DEVICE_HUB_MAX_PAYLOAD_BYTES) {
    throw new DeviceProtocolError("device_frame_too_large");
  }
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch (error) {
    throw new DeviceProtocolError(error instanceof StrictJsonError ? error.message : "device_frame_invalid");
  }
  return parseEnvelope(value, direction);
}

/** The typed body of a parsed envelope of the expected type. */
export function bodyOf<T extends DeviceMessageType>(envelope: Envelope, type: T): MessageBodies[T] {
  if (envelope.type !== type) throw new DeviceProtocolError("device_message_type_mismatch");
  return envelope.body as MessageBodies[T];
}

/** The device capability a tool needs (the grant scope an Execute of it falls under). */
export function toolCapability(tool: DeviceTool): Capability {
  switch (tool) {
    case "terminal": return "terminal";
    case "computer_use": return "computer";
    case "send_file": return "send_file";
    default: return "files";
  }
}
