/**
 * Enrollment and rotation of a Mac's device service (`atum.device-service/1` §3.3, `EnrollDevice`):
 * double-signed by the identity and approval keys, and a rotation also by the STORED approval
 * key (`previousApproval`), so the cloud cannot swap a device's keys without the owner's Touch ID
 * on that Mac. DA enforces this in route code and SQL (WS-1, migration 0180); this module is the
 * same decision as a pure function, for the desktop to check its own request before it sends it
 * and for the conformance vectors.
 */
import { verifyEs256 } from "./envelope";
import { deviceSignedBytes, keyId } from "./hashes";
import type { B64u, Capability, KeyId, Ms } from "./messages";

export interface EnrollBody {
  deviceServiceId: string;
  displayName: string;
  platform: "macos";
  osVersion: string;
  identityKey: B64u;
  approvalKey: B64u;
  matrix: { userId: string; deviceId: string; fingerprint: string };
  enrollmentEpoch: number;
  previousApprovalKid?: KeyId;
  scopes: Capability[];
  controllerKeys: KeyId[];
  issuedAt: Ms;
}

export interface EnrollDevice {
  body: EnrollBody;
  sigs: { identity: B64u; approval: B64u; previousApproval?: B64u };
}

/** `EnrollDevice` signed bytes: the device-service domain, type `EnrollDevice`, canonical body. */
export const enrollmentSignedBytes = (body: EnrollBody) => deviceSignedBytes("EnrollDevice", body);

/** The three signature verdicts the contract names; `previousApprovalValid` needs the stored key. */
export function enrollmentVerdicts(request: EnrollDevice, storedApprovalKey: B64u | null): {
  identityValid: boolean;
  approvalValid: boolean;
  previousApprovalValid: boolean;
} {
  const bytes = (() => {
    try {
      return enrollmentSignedBytes(request.body);
    } catch {
      return null;
    }
  })();
  if (!bytes) return { identityValid: false, approvalValid: false, previousApprovalValid: false };
  return {
    identityValid: verifyEs256(request.body.identityKey, bytes, request.sigs.identity),
    approvalValid: verifyEs256(request.body.approvalKey, bytes, request.sigs.approval),
    previousApprovalValid: storedApprovalKey !== null && request.sigs.previousApproval !== undefined &&
      verifyEs256(storedApprovalKey, bytes, request.sigs.previousApproval)
  };
}

export interface EnrollmentContext {
  /** The owner's Matrix user ID, read by DA from MAS (never from the request). */
  ownerUserId: string;
  activeControllerKeys: readonly KeyId[];
  /** This device service's stored row, if any. */
  stored: { ownerUserId: string; deviceServiceId: string; enrollmentEpoch: number; approvalKeyId: KeyId; approvalKey: B64u; state: "active" | "revoked" } | null;
  /** The owner's other active device services. */
  otherActive: readonly { deviceServiceId: string; matrixDeviceId: string; identityKeyId: KeyId; approvalKeyId: KeyId }[];
  request: EnrollDevice;
}

export type EnrollmentDecision =
  | { outcome: "enrolled"; status: "201" }
  | { outcome: "rotated"; status: "200" }
  | { outcome: "refused"; status: "400" | "403" | "409"; reason: "invalid" | "bad_signature" | "wrong_owner" | "rotation_unauthorized" | "enrollment_conflict" | "key_conflict" | "unknown_controller_key" | "revoked" };

/**
 * The registry's decision, in DA's order: both signatures; the owner; every pinned controller key
 * active; the row's owner and state; the epoch chain (a first enrollment is epoch 1 with no
 * previous key; a rotation is exactly the next epoch, names the stored approval key and is signed
 * by it); then one active service per Matrix device and one active owner per key.
 */
export function decideEnrollment(context: EnrollmentContext): EnrollmentDecision {
  const { request, stored } = context;
  const body = request.body;
  const verdicts = enrollmentVerdicts(request, stored?.approvalKey ?? null);
  if (!verdicts.identityValid || !verdicts.approvalValid) return { outcome: "refused", status: "400", reason: "bad_signature" };
  if (body.matrix.userId !== context.ownerUserId) return { outcome: "refused", status: "403", reason: "wrong_owner" };
  if (body.controllerKeys.some((kid) => !context.activeControllerKeys.includes(kid))) {
    return { outcome: "refused", status: "400", reason: "unknown_controller_key" };
  }
  if (stored && stored.ownerUserId !== context.ownerUserId) return { outcome: "refused", status: "409", reason: "enrollment_conflict" };
  if (stored?.state === "revoked") return { outcome: "refused", status: "403", reason: "revoked" };
  if (!stored) {
    if (body.enrollmentEpoch !== 1 || body.previousApprovalKid !== undefined) return { outcome: "refused", status: "403", reason: "rotation_unauthorized" };
  } else if (body.enrollmentEpoch !== stored.enrollmentEpoch + 1 || body.previousApprovalKid !== stored.approvalKeyId || !verdicts.previousApprovalValid) {
    return { outcome: "refused", status: "403", reason: "rotation_unauthorized" };
  }
  const others = context.otherActive.filter((other) => other.deviceServiceId !== body.deviceServiceId);
  if (others.some((other) => other.matrixDeviceId === body.matrix.deviceId)) return { outcome: "refused", status: "409", reason: "enrollment_conflict" };
  const keys = [keyId(Buffer.from(body.identityKey, "base64url")), keyId(Buffer.from(body.approvalKey, "base64url"))];
  if (others.some((other) => keys.includes(other.identityKeyId) || keys.includes(other.approvalKeyId))) {
    return { outcome: "refused", status: "409", reason: "key_conflict" };
  }
  return stored ? { outcome: "rotated", status: "200" } : { outcome: "enrolled", status: "201" };
}
