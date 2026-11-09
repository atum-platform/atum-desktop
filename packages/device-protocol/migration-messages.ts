/** Approved device-service 1.1 migration JSON frames. Binary chunks are separate. */
import type { Ms, Uuid } from "./messages";

export interface MigrationArchive { v: 1; sha256: string; bytes: number; files: number }
export interface MigrationOffer {
  migrationId: Uuid; agentPrincipal: Uuid; agentUserId: string; deviceServiceId: Uuid;
  enrollmentEpoch: number; accountEpoch: number; connectionId: Uuid;
  role: "initiator" | "participant"; archive: MigrationArchive; createdAt: Ms;
}
export interface MigrationRequest {
  migrationId: Uuid; agentPrincipal: Uuid; agentUserId: string;
  initiatorDeviceServiceId: Uuid; targetDeviceServiceId: Uuid;
  enrollmentEpoch: number; accountEpoch: number; connectionId: Uuid;
  issuedAt: Ms; expiresAt: Ms; holdUntil: Ms;
}
export interface MigrationDecline {
  migrationId: Uuid; agentPrincipal: Uuid; deviceServiceId: Uuid;
  enrollmentEpoch: number; accountEpoch: number; connectionId: Uuid;
  reason: "no_local_home" | "owner_declined" | "busy" | "export_failed" | "too_large" | "expired";
}
export type MigrationRefusal = "bad_signature" | "wrong_device" | "stale_connection" | "stale_enrollment"
  | "stale_account_epoch" | "not_enrolled" | "home_exists" | "too_large" | "not_requested"
  | "migration_closed" | "duplicate" | "too_many_snapshots" | "size_mismatch" | "hash_mismatch" | "chunk_invalid";
interface MigrationAckBase { migrationId: Uuid; deviceServiceId: Uuid }
export type MigrationAck = MigrationAckBase & (
  | { outcome: "send"; holdUntil: Ms }
  | { outcome: "staged"; sha256: string; bytes: number }
  | { outcome: "refused"; refusal: MigrationRefusal }
);
export interface MigrationSnapshot { deviceServiceId: Uuid; sha256: string; bytes: number; files: number }
export interface MigrationMissingSnapshot { deviceServiceId: Uuid; reason: "declined" | "refused" | "offline" | "expired" }
export interface MigrationReconcileReport {
  base: Uuid; other: Uuid;
  sessions: { merged: boolean; added: number; skipped: number; reason?: "schema_differs" | "one_side" };
  memories: Array<{ path: string; addedFromOther: number }>;
  skills: { bothKept: Array<{ name: string; otherName: string }>; onlyBase: string[]; onlyOther: string[] };
  oneSided: Array<{ path: string; side: "base" | "other"; default: "keep" }>;
  replaced: Array<{ path: string; kept: "base" }>;
  omitted: number;
}
interface MigrationReportBase {
  migrationId: Uuid; agentPrincipal: Uuid; missing: MigrationMissingSnapshot[];
  issuedAt: Ms; expiresAt: Ms; holdUntil: Ms;
}
export type MigrationReport = MigrationReportBase & (
  | { snapshots: [MigrationSnapshot]; report: null; reportSha256: null }
  | { snapshots: [MigrationSnapshot, MigrationSnapshot]; report: MigrationReconcileReport; reportSha256: string }
);
export interface MigrationChoose {
  migrationId: Uuid; agentPrincipal: Uuid; deviceServiceId: Uuid;
  enrollmentEpoch: number; accountEpoch: number; connectionId: Uuid;
  reportSha256: string | null; drop: string[]; takeOther: string[]; decidedAt: Ms;
}
export interface MigrationCancel {
  migrationId: Uuid; agentPrincipal: Uuid; deviceServiceId: Uuid;
  enrollmentEpoch: number; accountEpoch: number; connectionId: Uuid;
  reason: "owner_cancelled" | "sign_out" | "account_switch";
}
export type MigrationResult = { migrationId: Uuid; agentPrincipal: Uuid } & (
  | { outcome: "committed"; homeGeneration: 1; manifestSha256: string }
  | { outcome: "refused"; reason: "bad_signature" | "wrong_device" | "stale_connection" | "stale_enrollment"
      | "stale_account_epoch" | "unknown_migration" | "not_initiator" | "not_participant" | "wrong_state"
      | "expired" | "stale_report" | "invalid_choice" }
  | { outcome: "failed" | "abandoned"; reason: "home_exists" | "reconcile_failed" | "commit_failed"
      | "not_enrolled" | "expired" | "cancelled" }
);
export interface MigrationMessageBodies {
  MigrationOffer: MigrationOffer; MigrationRequest: MigrationRequest; MigrationDecline: MigrationDecline;
  MigrationAck: MigrationAck; MigrationReport: MigrationReport; MigrationChoose: MigrationChoose;
  MigrationCancel: MigrationCancel; MigrationResult: MigrationResult;
}
