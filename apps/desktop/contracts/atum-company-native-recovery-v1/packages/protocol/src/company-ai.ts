import { z } from "zod";

import { HomeRefSchema } from "./agent-home.js";

/** Frozen by `spec/company-ai/v1`. */
export const COMPANY_AI_PROFILE = "atum.company-ai/1" as const;
export const COMPANY_AI_PROFILE_V11 = "atum.company-ai/1.1" as const;
export const COMPANY_AI_SCHEMA_VERSION = 1 as const;
export const COMPANY_AI_CAPABILITY_PROFILE = "company_cited_answer" as const;
export const COMPANY_AI_DISPLAY_NAME = "Chief of Staff" as const;
export const COMPANY_AI_ROLE = "company_chief_of_staff" as const;
export const COMPANY_AI_HISTORY_SCOPE = "channel_shared_history" as const;
export const COMPANY_AI_TASK_KIND = "company_ai" as const;
export const COMPANY_AI_FUNDING_KIND = "company_wallet" as const;
export const COMPANY_AI_CONTROLLER_ROUTE_PREFIX = "/api/matrix/v1/cloud/controller/company-ai" as const;

export const COMPANY_AI_LIMITS = Object.freeze({
  assignmentWorkItems: 100,
  membershipWorkItems: 100,
  serviceUsersPerChannel: 100,
  contextEvidence: 40,
  citations: 40,
  excerptCharacters: 500,
  answerCharacters: 65_536,
} as const);
export const COMPANY_AI_PROACTIVE_LIMITS = Object.freeze({
  channelEvents: 20,
  channelCharacters: 8_000,
  sourceChecksPerLocalDay: 12,
  offersPerLocalDay: 2,
  quietStartHour: 21,
  quietEndHour: 8,
  sourceIntervalMs: 7_200_000,
  claimLeaseMs: 120_000,
} as const);

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const matrixUserId = z.string().min(4).max(512).regex(/^@[!-9;-~]{1,255}:[!-~]{1,255}$/u);
const roomId = z.string().min(4).max(512).regex(/^![!-9;-~]{1,255}:[!-~]{1,255}$/u);
const eventId = z.string().min(2).max(512).regex(/^[$][!-~]+$/u);
const deviceId = z.string().min(1).max(128).regex(/^[A-Z0-9_-]+$/u);
const memberRef = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u);
const cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const leaseToken = z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const accessToken = z.string().min(32).max(4096);
const sealedCiphertext = z.string().min(1).max(16_777_216);
const fileName = z.string().min(1).max(255);

const contentType = z.string().min(3).max(128)
  .regex(/^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,63}$/u);

const byteSize = z.number().int().min(0).max(20 * 1024 * 1024);
const timestampMs = nonnegativeInteger;

const utcTimestamp = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u)
  .refine(value => Number.isFinite(Date.parse(value)), "timestamp must be valid UTC RFC3339");

export const CompanyAIStateSchema = z.enum(["preparing", "ready", "paused", "attention"]);
export type CompanyAIState = z.infer<typeof CompanyAIStateSchema>;

export const CompanyAIFileRefV1Schema = z.object({
  v: z.literal(1), company_id: uuid, channel_id: uuid, file_id: uuid, revision: z.literal(1),
  name: fileName, content_type: contentType, size: byteSize, sha256,
}).strict();
export const CompanyAIFileRefV2Schema = z.object({
  v: z.literal(2), company_id: uuid,
  audience: z.object({ kind: z.literal("channel"), channel_id: uuid, visibility: z.enum(["public", "private"]) }).strict(),
  file_id: uuid, revision: z.literal(1), name: fileName, content_type: contentType, size: byteSize, sha256,
}).strict();
export const CompanyAIFileRefSchema = z.discriminatedUnion("v", [CompanyAIFileRefV1Schema, CompanyAIFileRefV2Schema]);
export type CompanyAIFileRef = z.infer<typeof CompanyAIFileRefSchema>;

export const CompanyAIChannelCitationSchema = z.object({
  kind: z.literal("channel"), sourceId: uuid, channelId: uuid, eventId,
  revisionEventId: eventId.optional(), at: utcTimestamp,
}).strict();
export const CompanyAIFileCitationSchema = z.object({
  kind: z.literal("company_file"), sourceId: uuid, channelId: uuid, file: CompanyAIFileRefSchema,
}).strict();
export const CompanyAICitationSchema = z.discriminatedUnion("kind", [
  CompanyAIChannelCitationSchema, CompanyAIFileCitationSchema,
]);
export type CompanyAICitation = z.infer<typeof CompanyAICitationSchema>;

export const CompanyAIGapCodeSchema = z.enum([
  "assignment_unavailable", "lease_contention", "reader_unavailable", "roster_unresolved",
  "backfill_pending", "history_gap", "join_changed", "file_unavailable",
  "file_content_not_extractable", "receipt_pending", "unsupported_format", "source_stale",
  "publication_revoked",
]);

export const CompanyAIAgentSchema = z.object({
  principal: uuid,
  userId: matrixUserId,
  displayName: z.literal(COMPANY_AI_DISPLAY_NAME),
}).strict();
export type CompanyAIAgent = z.infer<typeof CompanyAIAgentSchema>;

export const CompanyAIViewSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  companyId: uuid,
  agent: CompanyAIAgentSchema,
  enabled: z.boolean(),
  revision: positiveInteger,
  state: CompanyAIStateSchema,
  canManage: z.boolean(),
}).strict();
export type CompanyAIView = z.infer<typeof CompanyAIViewSchema>;

export const CompanyAIConfigureRequestSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  requestId: uuid,
  expectedRevision: positiveInteger,
  enabled: z.boolean(),
}).strict();
export type CompanyAIConfigureRequest = z.infer<typeof CompanyAIConfigureRequestSchema>;

export const CompanyAITaskStopRequestSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), requestId: uuid,
}).strict();
export type CompanyAITaskStopRequest = z.infer<typeof CompanyAITaskStopRequestSchema>;

export const CompanyAITaskStopResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  taskId: uuid,
  state: z.enum(["cancelled", "stopped"]),
}).strict();
export type CompanyAITaskStopResponse = z.infer<typeof CompanyAITaskStopResponseSchema>;

export const CompanyAIErrorCodeSchema = z.enum([
  "invalid", "denied", "not_found", "conflict", "update_required", "unavailable",
  "budget_exhausted", "ai_disabled", "source_stale", "stopped",
]);
export const CompanyAIErrorSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  error: z.object({ code: CompanyAIErrorCodeSchema }).strict(),
}).strict();
export type CompanyAIError = z.infer<typeof CompanyAIErrorSchema>;

/** The explicit organization-owner branch. It cannot carry a personal owner id. */
export const CompanyAIOwnerSchema = z.object({
  kind: z.literal("company"), companyId: uuid,
}).strict();
export type CompanyAIOwner = z.infer<typeof CompanyAIOwnerSchema>;

export const CompanyAIBindingSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  owner: CompanyAIOwnerSchema,
  agentPrincipal: uuid,
  agentUserId: matrixUserId,
  executorId: uuid,
  deviceId,
  assignmentEpoch: positiveInteger,
  assignmentState: z.enum(["active", "draining"]),
  homeId: uuid,
  homeEpoch: positiveInteger,
  executorTerm: positiveInteger,
  storeGeneration: positiveInteger,
  custodyGeneration: nonnegativeInteger,
  sessionState: z.enum(["creating", "rotating", "active", "revoking", "revoked"]),
  trustState: z.enum(["pending", "active", "recovery_needed"]),
  capabilityProfile: z.literal(COMPANY_AI_CAPABILITY_PROFILE),
}).strict();
export type CompanyAIBinding = z.infer<typeof CompanyAIBindingSchema>;

export const CompanyAIAssignmentWorkPageSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  items: z.array(CompanyAIBindingSchema).max(COMPANY_AI_LIMITS.assignmentWorkItems),
  nextCursor: cursor.nullable(),
}).strict();
export type CompanyAIAssignmentWorkPage = z.infer<typeof CompanyAIAssignmentWorkPageSchema>;

const leaseBase = {
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  assignmentEpoch: positiveInteger,
  homeEpoch: positiveInteger,
  holderId: uuid,
};

export const CompanyAILeaseRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...leaseBase, operation: z.literal("acquire") }).strict(),
  z.object({ ...leaseBase, operation: z.literal("renew"), leaseToken }).strict(),
  z.object({ ...leaseBase, operation: z.literal("release"), leaseToken }).strict(),
]);
export type CompanyAILeaseRequest = z.infer<typeof CompanyAILeaseRequestSchema>;

export const CompanyAILeaseResponseSchema = z.discriminatedUnion("state", [
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("held"),
    executorId: uuid, holderId: uuid, leaseToken, leaseGeneration: positiveInteger,
    assignmentEpoch: positiveInteger, homeEpoch: positiveInteger,
    acquiredAtMs: timestampMs, expiresAtMs: timestampMs,
  }).strict().refine(value => value.expiresAtMs > value.acquiredAtMs, "lease expiry follows acquisition"),
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("free"),
    assignmentEpoch: positiveInteger, homeEpoch: positiveInteger,
  }).strict(),
]);
export type CompanyAILeaseResponse = z.infer<typeof CompanyAILeaseResponseSchema>;

export const CompanyAISessionRequestSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), operation: z.enum(["create", "rotate"]),
  assignmentEpoch: positiveInteger, homeEpoch: positiveInteger, holderId: uuid, leaseToken,
  storeGeneration: positiveInteger,
}).strict();
export type CompanyAISessionRequest = z.infer<typeof CompanyAISessionRequestSchema>;

export const CompanyAISessionResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("active"),
  executorId: uuid, agentUserId: matrixUserId, deviceId, assignmentEpoch: positiveInteger,
  homeEpoch: positiveInteger, storeGeneration: positiveInteger, accessToken,
  issuedAtMs: timestampMs, expiresAtMs: timestampMs,
}).strict().refine(value => value.expiresAtMs > value.issuedAtMs, "session expiry follows issue time");
export type CompanyAISessionResponse = z.infer<typeof CompanyAISessionResponseSchema>;

const custodyBase = {
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), assignmentEpoch: positiveInteger,
  homeEpoch: positiveInteger, holderId: uuid, leaseToken, storeGeneration: positiveInteger,
};

export const CompanyAICustodyRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...custodyBase, operation: z.literal("get") }).strict(),
  z.object({
    ...custodyBase, operation: z.literal("put"), expectedGeneration: nonnegativeInteger,
    sealedCiphertext,
  }).strict(),
]);
export type CompanyAICustodyRequest = z.infer<typeof CompanyAICustodyRequestSchema>;

export const CompanyAICustodyResponseSchema = z.discriminatedUnion("state", [
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("empty"),
    executorId: uuid, assignmentEpoch: positiveInteger, homeEpoch: positiveInteger,
    storeGeneration: positiveInteger, custodyGeneration: z.literal(0), sealedCiphertext: z.null(),
  }).strict(),
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("published"),
    executorId: uuid, assignmentEpoch: positiveInteger, homeEpoch: positiveInteger,
    storeGeneration: positiveInteger, custodyGeneration: positiveInteger, sealedCiphertext,
  }).strict(),
]);
export type CompanyAICustodyResponse = z.infer<typeof CompanyAICustodyResponseSchema>;

export const CompanyAIServiceUserKindSchema = z.enum(["project_reader", "company_cos"]);
export const CompanyAIServiceUserSchema = z.object({
  kind: CompanyAIServiceUserKindSchema,
  principal: uuid,
  userId: matrixUserId,
  executorId: uuid,
  assignmentEpoch: positiveInteger,
}).strict();
export type CompanyAIServiceUser = z.infer<typeof CompanyAIServiceUserSchema>;

export const CompanyAIMembershipPlanSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  companyId: uuid, channelId: uuid, roomId,
  companyGeneration: positiveInteger, channelGeneration: positiveInteger,
  managerAssignmentEpoch: positiveInteger, combinedScopeDigest: sha256,
  desiredServiceUsers: z.array(CompanyAIServiceUserSchema).max(COMPANY_AI_LIMITS.serviceUsersPerChannel),
  excludedServiceUsers: z.array(CompanyAIServiceUserSchema).max(COMPANY_AI_LIMITS.serviceUsersPerChannel),
  needsReconcile: z.boolean(),
}).strict().superRefine((value, context) => {
  const desired = new Set(value.desiredServiceUsers.map(user => user.principal));

  if (desired.size !== value.desiredServiceUsers.length) {
    context.addIssue({ code: "custom", path: ["desiredServiceUsers"], message: "desired principals must be unique" });
  }

  const excluded = new Set(value.excludedServiceUsers.map(user => user.principal));

  if (excluded.size !== value.excludedServiceUsers.length || [...desired].some(principal => excluded.has(principal))) {
    context.addIssue({ code: "custom", path: ["excludedServiceUsers"], message: "service roster sets must be unique and disjoint" });
  }
});

export const CompanyAIMembershipWorkPageSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  items: z.array(CompanyAIMembershipPlanSchema).max(COMPANY_AI_LIMITS.membershipWorkItems),
  nextCursor: cursor.nullable(),
}).strict();
export type CompanyAIMembershipWorkPage = z.infer<typeof CompanyAIMembershipWorkPageSchema>;

export const CompanyAIObservedServiceUserSchema = z.object({
  kind: CompanyAIServiceUserKindSchema, principal: uuid, userId: matrixUserId,
  membership: z.enum(["join", "invite", "leave", "ban"]), joinEventId: eventId.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.membership === "join") !== (value.joinEventId !== null)) {
    context.addIssue({ code: "custom", path: ["joinEventId"], message: "only a joined service user has a join event" });
  }
});

export const CompanyAIChannelMembersSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), companyId: uuid, channelId: uuid, roomId,
  managerAssignmentEpoch: positiveInteger, combinedScopeDigest: sha256,
  serviceUsers: z.array(CompanyAIObservedServiceUserSchema).max(COMPANY_AI_LIMITS.serviceUsersPerChannel),
}).strict().superRefine((value, context) => {
  if (new Set(value.serviceUsers.map(user => user.principal)).size !== value.serviceUsers.length) {
    context.addIssue({ code: "custom", path: ["serviceUsers"], message: "observed service principals must be unique" });
  }
});
export type CompanyAIChannelMembers = z.infer<typeof CompanyAIChannelMembersSchema>;

/** The acknowledgement carries observed membership only; it cannot restate a desired plan. */
export const CompanyAIMembershipReconciledRequestSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), operation: z.literal("reconciled"),
  companyId: uuid, channelId: uuid, roomId, managerAssignmentEpoch: positiveInteger,
  combinedScopeDigest: sha256, policyWitness: sha256,
  observedServiceUsers: z.array(CompanyAIObservedServiceUserSchema).max(COMPANY_AI_LIMITS.serviceUsersPerChannel),
}).strict().superRefine((value, context) => {
  if (new Set(value.observedServiceUsers.map(user => user.principal)).size !== value.observedServiceUsers.length) {
    context.addIssue({ code: "custom", path: ["observedServiceUsers"], message: "observed service principals must be unique" });
  }
});
export type CompanyAIMembershipReconciledRequest = z.infer<typeof CompanyAIMembershipReconciledRequestSchema>;

export const CompanyAIMembershipReconciledResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), recorded: z.literal(true),
  companyId: uuid, channelId: uuid, combinedScopeDigest: sha256,
}).strict();

export const CompanyAIIntakeRequestSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), requestId: uuid, executorId: uuid, roomId, eventId,
}).strict();
export type CompanyAIIntakeRequest = z.infer<typeof CompanyAIIntakeRequestSchema>;

export const CompanyAIIntakeResponseSchema = z.discriminatedUnion("state", [
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("queued"),
    taskId: uuid, seq: positiveInteger,
  }).strict(),
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("duplicate"),
    taskId: uuid, seq: positiveInteger,
  }).strict(),
  z.object({ schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("ignored") }).strict(),
]);
export type CompanyAIIntakeResponse = z.infer<typeof CompanyAIIntakeResponseSchema>;

/** Private trusted-adapter facts. This object is never nested in `CompanyAIIntakeRequestSchema`. */
const companyAIVerifiedEventShape = {
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  companyId: uuid, channelId: uuid, roomId, eventId, threadRootEventId: eventId,
  inReplyToEventId: eventId.nullable(),
  senderPrincipal: uuid, senderMemberRef: memberRef, senderUserId: matrixUserId,
  agentPrincipal: uuid, agentUserId: matrixUserId,
  relation: z.enum(["top_level", "thread"]), eventType: z.literal("m.room.message"),
  messageType: z.literal("m.text"), original: z.literal(true),
  requesterMembershipEpoch: positiveInteger, channelAdmissionGeneration: positiveInteger,
  authorityGeneration: positiveInteger, channelGeneration: positiveInteger,
  observedStreamPosition: nonnegativeInteger, factsStreamPosition: nonnegativeInteger,
};

const verifiedEventInvariants = (value: {
  factsStreamPosition: number; observedStreamPosition: number; relation: "top_level" | "thread";
  threadRootEventId: string; eventId: string;
}, context: z.RefinementCtx) => {
  if (value.factsStreamPosition < value.observedStreamPosition) {
    context.addIssue({ code: "custom", path: ["factsStreamPosition"], message: "membership facts must be caught up" });
  }

  if (value.relation === "top_level" && value.threadRootEventId !== value.eventId) {
    context.addIssue({ code: "custom", path: ["threadRootEventId"], message: "a top-level task roots at its trigger" });
  }
};

export const CompanyAIVerifiedEventSchema = z.object({
  ...companyAIVerifiedEventShape, mentionedAgent: z.literal(true),
}).strict().superRefine(verifiedEventInvariants);
export type CompanyAIVerifiedEvent = z.infer<typeof CompanyAIVerifiedEventSchema>;

/** A trusted re-fetch for a proactive candidate. It is intentionally not a mention. */
export const CompanyAIProactiveVerifiedEventSchema = z.object({
  ...companyAIVerifiedEventShape, mentionedAgent: z.literal(false),
}).strict().superRefine(verifiedEventInvariants);
export type CompanyAIProactiveVerifiedEvent = z.infer<typeof CompanyAIProactiveVerifiedEventSchema>;

export const CompanyAIProactiveSettingSchema = z.object({
  profile: z.literal(COMPANY_AI_PROFILE_V11), companyId: uuid, enabled: z.boolean(), revision: positiveInteger,
  quietHours: z.object({ startHour: z.literal(COMPANY_AI_PROACTIVE_LIMITS.quietStartHour),
    endHour: z.literal(COMPANY_AI_PROACTIVE_LIMITS.quietEndHour) }).strict(),
  sourceChecksPerLocalDay: z.literal(COMPANY_AI_PROACTIVE_LIMITS.sourceChecksPerLocalDay),
  offersPerLocalDay: z.literal(COMPANY_AI_PROACTIVE_LIMITS.offersPerLocalDay),
}).strict();
export type CompanyAIProactiveSetting = z.infer<typeof CompanyAIProactiveSettingSchema>;

export const CompanyAIProactiveSettingRequestSchema = z.object({
  profile: z.literal(COMPANY_AI_PROFILE_V11), requestId: uuid, expectedRevision: positiveInteger,
  enabled: z.boolean(),
}).strict();
export type CompanyAIProactiveSettingRequest = z.infer<typeof CompanyAIProactiveSettingRequestSchema>;

const proactiveBase = { profile: z.literal(COMPANY_AI_PROFILE_V11), requestId: uuid, leaseToken };
export const CompanyAIProactiveClaimRequestSchema = z.object({
  ...proactiveBase, operation: z.literal("claim"),
}).strict();
export const CompanyAIProactiveSettleRequestSchema = z.object({
  ...proactiveBase, operation: z.literal("settle"), claimId: uuid, roomId,
  checkpoint: z.object({ eventId: eventId.nullable(), atMs: timestampMs.nullable() }).strict(),
  disposition: z.enum(["none", "offer"]),
  offer: z.object({ eventId, findingHash: sha256 }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.checkpoint.eventId === null) !== (value.checkpoint.atMs === null)) {
    context.addIssue({ code: "custom", path: ["checkpoint"], message: "checkpoint event and time move together" });
  }

  if ((value.disposition === "offer") !== (value.offer !== undefined)) {
    context.addIssue({ code: "custom", path: ["offer"], message: "only an offer disposition carries a candidate" });
  }
});
export const CompanyAIProactiveRequestSchema = z.union([
  CompanyAIProactiveClaimRequestSchema, CompanyAIProactiveSettleRequestSchema,
]);
export type CompanyAIProactiveRequest = z.infer<typeof CompanyAIProactiveRequestSchema>;

export const CompanyAIProactiveClaimResponseSchema = z.discriminatedUnion("decision", [
  z.object({
    profile: z.literal(COMPANY_AI_PROFILE_V11), decision: z.literal("defer"),
    reason: z.enum(["disabled", "not_due", "quiet_hours", "missing_time_zone", "cap_exhausted", "active_claim", "no_channel"]),
    retryAtMs: timestampMs,
  }).strict(),
  z.object({
    profile: z.literal(COMPANY_AI_PROFILE_V11), decision: z.literal("claimed"), claimId: uuid,
    companyId: uuid, channelId: uuid, roomId, afterEventId: eventId.nullable(),
    maxEvents: z.literal(COMPANY_AI_PROACTIVE_LIMITS.channelEvents),
    maxCharacters: z.literal(COMPANY_AI_PROACTIVE_LIMITS.channelCharacters),
    settingRevision: positiveInteger, expiresAtMs: timestampMs,
  }).strict(),
]);
export type CompanyAIProactiveClaimResponse = z.infer<typeof CompanyAIProactiveClaimResponseSchema>;

export const CompanyAIProactiveSettleResponseSchema = z.discriminatedUnion("state", [
  z.object({ profile: z.literal(COMPANY_AI_PROFILE_V11), state: z.literal("none"), claimId: uuid }).strict(),
  z.object({ profile: z.literal(COMPANY_AI_PROFILE_V11), state: z.literal("duplicate"), claimId: uuid }).strict(),
  z.object({
    profile: z.literal(COMPANY_AI_PROFILE_V11), state: z.literal("queued"), claimId: uuid,
    taskId: uuid, seq: positiveInteger,
  }).strict(),
]);
export type CompanyAIProactiveSettleResponse = z.infer<typeof CompanyAIProactiveSettleResponseSchema>;

export const CompanyAIAnswerScopeSchema = z.object({
  companyId: uuid, channelId: uuid, threadRootEventId: eventId,
  historyScope: z.literal(COMPANY_AI_HISTORY_SCOPE), scopeDigest: sha256,
  authorityGeneration: positiveInteger, channelGeneration: positiveInteger,
  sourceGeneration: nonnegativeInteger, requesterMembershipEpoch: positiveInteger,
  channelAdmissionGeneration: positiveInteger, correctionRevision: nonnegativeInteger,
}).strict();
export type CompanyAIAnswerScope = z.infer<typeof CompanyAIAnswerScopeSchema>;

export const CompanyAIRunStateSchema = z.enum([
  "queued", "claimed", "dispatched", "settled", "published", "cancelled", "stopped", "failed", "uncertain",
]);

export const CompanyAIContextRequestSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), taskId: uuid, leaseToken,
}).strict();
export type CompanyAIContextRequest = z.infer<typeof CompanyAIContextRequestSchema>;

export const CompanyAIContextEvidenceSchema = z.object({
  excerpt: z.string().min(1).max(COMPANY_AI_LIMITS.excerptCharacters),
  citation: CompanyAICitationSchema,
  assertion: z.enum(["source", "correction"]),
  sourceEpoch: positiveInteger,
  publicationGeneration: positiveInteger,
  revisionDigest: sha256,
}).strict();
export type CompanyAIContextEvidence = z.infer<typeof CompanyAIContextEvidenceSchema>;

export const CompanyAIContextCoverageSchema = z.object({
  state: z.enum(["empty", "pending", "live", "partial", "stale", "paused", "attention"]),
  asOf: utcTimestamp.nullable(),
  gaps: z.array(CompanyAIGapCodeSchema).max(10),
}).strict().superRefine((value, context) => {
  const current = value.state === "live" || value.state === "partial";

  if (current !== (value.asOf !== null)) {
    context.addIssue({ code: "custom", path: ["asOf"], message: "only current coverage carries an as-of time" });
  }
});

export const CompanyAIContextResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  scope: CompanyAIAnswerScopeSchema,
  evidence: z.array(CompanyAIContextEvidenceSchema).max(COMPANY_AI_LIMITS.contextEvidence),
  coverage: CompanyAIContextCoverageSchema,
  validUntil: utcTimestamp,
}).strict();
export type CompanyAIContextResponse = z.infer<typeof CompanyAIContextResponseSchema>;

export const CompanyAIOutboxBodySchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  companyId: uuid, channelId: uuid, threadRootEventId: eventId, triggerEventId: eventId,
  taskId: uuid, scopeDigest: sha256, correctionRevision: nonnegativeInteger,
  text: z.string().min(1).max(COMPANY_AI_LIMITS.answerCharacters),
  citations: z.array(CompanyAICitationSchema).max(COMPANY_AI_LIMITS.citations),
  coverage: CompanyAIContextCoverageSchema,
}).strict();
export type CompanyAIOutboxBody = z.infer<typeof CompanyAIOutboxBodySchema>;

const companyAIUsage = z.object({
  /** Operational duration only. Amendment A1 assigns no compute tariff. */
  computeSeconds: z.number().int().min(0).max(86_400),
}).strict();

const companyAIOutboxRef = z.object({
  outboxId: uuid,
  kind: z.enum(["answer", "status"]),
  bodySha256: sha256,
  bodyKey: z.string().min(1).max(512),
}).strict();

export const CompanyAIOutboxRefSchema = companyAIOutboxRef;

/** Platform recovery attempt; matches company_native_assert_attempt/json_int(0,100). */
export const CompanyAINativeAttemptSchema = z.number().int().min(0).max(100);

const companyAIAgentBase = { schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION) };
export const CompanyAIAgentTakeRequestSchema = z.object({
  ...companyAIAgentBase, operation: z.literal("take"), leaseToken,
}).strict();
export const CompanyAIAgentReceiptRequestSchema = z.object({
  nativeAttempt: CompanyAINativeAttemptSchema.optional(),
  ...companyAIAgentBase, operation: z.literal("receipt"), seq: positiveInteger, originReceiptEvent: eventId,
}).strict();
export const CompanyAIAgentDispatchedRequestSchema = z.object({
  ...companyAIAgentBase, operation: z.literal("dispatched"), seq: positiveInteger, leaseToken,
  taskId: uuid, invocationId: uuid,
}).strict();
export const CompanyAIAgentReleaseRequestSchema = z.object({
  nativeAttempt: CompanyAINativeAttemptSchema.optional(),
  ...companyAIAgentBase, operation: z.literal("release"), seq: positiveInteger, leaseToken, taskId: uuid,
}).strict();
export const CompanyAIAgentRecoverRequestSchema = z.object({
  nativeAttempt: CompanyAINativeAttemptSchema.optional(),
  ...companyAIAgentBase, operation: z.literal("recover"), seq: positiveInteger, leaseToken, taskId: uuid,
  action: z.enum(["adopt", "release"]),
}).strict();
export const CompanyAIAgentCommitRequestSchema = z.object({
  nativeAttempt: CompanyAINativeAttemptSchema.optional(),
  ...companyAIAgentBase, operation: z.literal("commit"), seq: positiveInteger, leaseToken,
  leaseGeneration: positiveInteger, taskId: uuid, invocationId: uuid,
  outcome: z.enum(["answered", "stopped", "failed", "uncertain"]),
  usage: companyAIUsage, expectedGeneration: nonnegativeInteger,
  home: HomeRefSchema.optional(), outbox: companyAIOutboxRef,
}).strict().superRefine((value, context) => {
  if (value.home !== undefined && value.home.generation !== value.expectedGeneration + 1) {
    context.addIssue({ code: "custom", path: ["home", "generation"], message: "home generation must advance by one" });
  }

  if ((value.outcome === "answered") !== (value.outbox.kind === "answer")) {
    context.addIssue({ code: "custom", path: ["outbox", "kind"], message: "only an answered company task commits an answer body" });
  }
});
export type CompanyAIAgentCommitRequest = z.infer<typeof CompanyAIAgentCommitRequestSchema>;

export const CompanyAIAgentAbandonRequestSchema = z.object({
  nativeAttempt: CompanyAINativeAttemptSchema.optional(),
  ...companyAIAgentBase, operation: z.literal("abandon"), seq: positiveInteger, leaseToken,
  leaseGeneration: positiveInteger, taskId: uuid,
  reason: z.enum(["stale", "unfunded", "stopped", "unsupported", "failed"]),
  outbox: companyAIOutboxRef,
}).strict();
export const CompanyAIAgentOutboxRequestSchema = z.object({
  nativeAttempt: CompanyAINativeAttemptSchema.optional(),
  ...companyAIAgentBase, operation: z.literal("outbox"), leaseToken,
}).strict();
export const CompanyAIAgentPublishedRequestSchema = z.object({
  nativeAttempt: CompanyAINativeAttemptSchema.optional(),
  ...companyAIAgentBase, operation: z.literal("published"), taskId: uuid, outboxId: uuid,
  publishedEvent: eventId, scopeDigest: sha256, correctionRevision: nonnegativeInteger,
}).strict();
export const CompanyAIAgentHomeRequestSchema = z.object({
  ...companyAIAgentBase, operation: z.literal("home"),
}).strict();
export const CompanyAIAgentLearnRequestSchema = z.object({
  ...companyAIAgentBase, operation: z.literal("learn"), taskId: uuid, leaseToken,
  leaseGeneration: positiveInteger, expectedGeneration: nonnegativeInteger, home: HomeRefSchema,
}).strict().superRefine((value, context) => {
  if (value.home.generation !== value.expectedGeneration + 1) {
    context.addIssue({ code: "custom", path: ["home", "generation"], message: "home generation must advance by one" });
  }
});

export const CompanyAIAgentRequestSchema = z.discriminatedUnion("operation", [
  CompanyAIAgentTakeRequestSchema, CompanyAIAgentReceiptRequestSchema,
  CompanyAIAgentDispatchedRequestSchema, CompanyAIAgentReleaseRequestSchema,
  CompanyAIAgentRecoverRequestSchema,
  CompanyAIAgentCommitRequestSchema, CompanyAIAgentAbandonRequestSchema,
  CompanyAIAgentOutboxRequestSchema, CompanyAIAgentPublishedRequestSchema,
  CompanyAIAgentHomeRequestSchema, CompanyAIAgentLearnRequestSchema,
]);
export type CompanyAIAgentRequest = z.infer<typeof CompanyAIAgentRequestSchema>;

export const CompanyAIQueuedItemSchema = z.object({
  seq: positiveInteger, taskId: uuid, source: z.literal("matrix"),
  enqueuedAtMs: timestampMs, takenLeaseGeneration: positiveInteger,
  triggerEventId: eventId, threadRootEventId: eventId, requestHash: sha256,
}).strict();
/** A taken row left behind by another lease, with everything recovery needs. */
export const CompanyAIStaleItemSchema = z.object({
  seq: positiveInteger, taskId: uuid, state: CompanyAIRunStateSchema,
  dispatched: z.boolean(), hold: z.boolean(), invocationId: uuid.nullable(),
}).strict();
export const CompanyAIAgentTakeResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  item: CompanyAIQueuedItemSchema.nullable(), stale: z.array(positiveInteger).max(100),
  staleItems: z.array(CompanyAIStaleItemSchema).max(100).optional(),
}).strict().refine(value => new Set(value.stale).size === value.stale.length
  && (value.staleItems === undefined
    || JSON.stringify(value.stale) === JSON.stringify(value.staleItems.map(item => item.seq))));
export const CompanyAIAgentRecoverAdoptResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), ok: z.literal(true),
  action: z.literal("adopt"), seq: positiveInteger, taskId: uuid,
  state: CompanyAIRunStateSchema, dispatched: z.boolean(), hold: z.boolean(),
  invocationId: uuid.nullable(),
}).strict();
export const CompanyAIAgentRecoverReleaseResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), ok: z.literal(true),
  action: z.literal("release"), seq: positiveInteger, taskId: uuid,
  state: z.literal("cancelled"), chargedMicroProtons: nonnegativeInteger,
  releasedMicroProtons: nonnegativeInteger,
}).strict();
export const CompanyAIAgentOkResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), ok: z.literal(true),
}).strict();
export const CompanyAIAgentCommitResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), transactionId: uuid,
  homeGeneration: nonnegativeInteger, outboxId: uuid,
}).strict();
export const CompanyAIAgentAbandonResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), transactionId: uuid,
  state: z.enum(["done", "dropped"]), outcome: z.literal("uncertain").nullable(),
}).strict();
export const CompanyAIAgentOutboxResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
  rows: z.array(z.object({
    taskId: uuid, outboxId: uuid, kind: z.enum(["answer", "status"]),
    bodySha256: sha256, bodyKey: z.string().min(1).max(512), transactionId: uuid,
    queueSeq: positiveInteger, invocationId: uuid, createdAtMs: timestampMs,
  }).strict()).max(100),
}).strict();
export const CompanyAIAgentHomeResponseSchema = z.union([
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), generation: z.literal(0),
    manifestKey: z.null(), manifestSha256: z.null(), committedAtMs: z.null(),
  }).strict(),
  HomeRefSchema.extend({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
    parentGeneration: nonnegativeInteger, committedAtMs: timestampMs,
  }).strict(),
]);
export const CompanyAIAgentLearnResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), homeGeneration: positiveInteger,
}).strict();
export const CompanyAIAgentResponseSchema = z.union([
  CompanyAIAgentTakeResponseSchema, CompanyAIAgentOkResponseSchema,
  CompanyAIAgentRecoverAdoptResponseSchema, CompanyAIAgentRecoverReleaseResponseSchema,
  CompanyAIAgentCommitResponseSchema, CompanyAIAgentAbandonResponseSchema,
  CompanyAIAgentOutboxResponseSchema, CompanyAIAgentHomeResponseSchema,
  CompanyAIAgentLearnResponseSchema,
]);
export type CompanyAIAgentResponse = z.infer<typeof CompanyAIAgentResponseSchema>;

const companyAIInvocationBase = {
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), taskId: uuid,
};

export const CompanyAIInvocationRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...companyAIInvocationBase, operation: z.literal("claim"), leaseToken }).strict(),
  z.object({ ...companyAIInvocationBase, operation: z.literal("dispatch"), leaseToken, invocationId: uuid }).strict(),
  z.object({
    ...companyAIInvocationBase, operation: z.literal("complete"), invocationId: uuid,
    nativeAttempt: CompanyAINativeAttemptSchema.optional(),
    outcome: z.enum(["answered", "stopped", "failed", "uncertain"]), usage: companyAIUsage,
  }).strict(),
  z.object({ ...companyAIInvocationBase, operation: z.literal("result"), invocationId: uuid }).strict(),
]);
export type CompanyAIInvocationRequest = z.infer<typeof CompanyAIInvocationRequestSchema>;

export const CompanyAIModelGrantSchema = z.object({
  token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u), expiresAtMs: timestampMs,
  aliases: z.tuple([z.literal("default")]), alias: z.literal("default"), model: z.literal("nguyet-thuc"),
  effort: z.enum(["low", "medium", "high"]), policyDigest: sha256,
  contextBudget: positiveInteger, outputBudget: positiveInteger,
  maxTurnMicroProtons: positiveInteger, ceilingMicroProtons: positiveInteger,
  funding: z.literal(COMPANY_AI_FUNDING_KIND), tools: z.tuple([]),
}).strict().refine(value => value.maxTurnMicroProtons <= value.ceilingMicroProtons,
"model call maximum must fit its company reservation");

export const CompanyAIInvocationResponseSchema = z.discriminatedUnion("state", [
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("claimed"),
    taskId: uuid, invocationId: uuid, expiresAtMs: timestampMs,
  }).strict(),
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("dispatched"),
    taskKind: z.literal(COMPANY_AI_TASK_KIND), taskId: uuid, invocationId: uuid,
    expiresAtMs: timestampMs, grantProfile: z.literal(COMPANY_AI_PROFILE),
    grant: CompanyAIModelGrantSchema,
    budget: z.object({
      reservationId: uuid, funding: z.literal(COMPANY_AI_FUNDING_KIND),
      ceilingMicroProtons: positiveInteger, computeSeconds: positiveInteger, firstAdmission: z.boolean(),
    }).strict(),
  }).strict().superRefine((value, context) => {
    if (value.grant.ceilingMicroProtons !== value.budget.ceilingMicroProtons) {
      context.addIssue({ code: "custom", path: ["grant", "ceilingMicroProtons"], message: "grant and budget ceilings must match" });
    }
  }),
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION),
    state: z.enum(["completed", "stopped", "failed", "uncertain"]),
    taskId: uuid, invocationId: uuid, transactionId: uuid,
  }).strict(),
  z.object({ schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), state: z.literal("unknown") }).strict(),
]);
export type CompanyAIInvocationResponse = z.infer<typeof CompanyAIInvocationResponseSchema>;

export const CompanyAIPublishCheckRequestSchema = z.object({
  schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), taskId: uuid, outboxId: uuid,
  scopeDigest: sha256, correctionRevision: nonnegativeInteger,
}).strict();
export type CompanyAIPublishCheckRequest = z.infer<typeof CompanyAIPublishCheckRequestSchema>;
export const CompanyAIPublishCheckResponseSchema = z.discriminatedUnion("verdict", [
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), verdict: z.literal("publish"),
    taskId: uuid, outboxId: uuid, roomId, threadRootEventId: eventId,
    triggerEventId: eventId, transactionId: uuid,
  }).strict(),
  z.object({
    schemaVersion: z.literal(COMPANY_AI_SCHEMA_VERSION), verdict: z.literal("withhold"),
    taskId: uuid, outboxId: uuid, state: z.literal("body_free_terminal"),
    reason: z.enum(["stopped", "authority_changed", "source_stale", "scope_mismatch", "correction_changed"]),
    retry: z.literal("none"),
  }).strict(),
]);
export type CompanyAIPublishCheckResponse = z.infer<typeof CompanyAIPublishCheckResponseSchema>;

export const CompanyAICapabilityProfileSchema = z.object({
  profile: z.literal(COMPANY_AI_PROFILE),
  capabilityProfile: z.literal(COMPANY_AI_CAPABILITY_PROFILE),
  tools: z.tuple([]),
}).strict();
export type CompanyAICapabilityProfile = z.infer<typeof CompanyAICapabilityProfileSchema>;

/** Native Shell seams. The Shell derives the actor from MAS before invoking them. */
export interface CompanyAINativeHandlers {
  read(companyId: string): Promise<CompanyAIView>;
  configure(companyId: string, input: CompanyAIConfigureRequest): Promise<CompanyAIView>;
  proactiveSetting(companyId: string): Promise<CompanyAIProactiveSetting>;
  configureProactive(companyId: string, input: CompanyAIProactiveSettingRequest): Promise<CompanyAIProactiveSetting>;
  stop(companyId: string, taskId: string, input: CompanyAITaskStopRequest): Promise<CompanyAITaskStopResponse>;
}

/** New controller seams. Agent/invocation operations reuse their frozen 1.8/1.12 validators unchanged. */
export interface CompanyAIControllerHandlers {
  assignments(cursorValue: string | null): Promise<CompanyAIAssignmentWorkPage>;
  membershipWork(cursorValue: string | null): Promise<CompanyAIMembershipWorkPage>;
  channelMembers(companyId: string, channelId: string): Promise<CompanyAIChannelMembers>;
  membership(input: CompanyAIMembershipReconciledRequest): Promise<z.infer<typeof CompanyAIMembershipReconciledResponseSchema>>;
  intake(input: CompanyAIIntakeRequest): Promise<CompanyAIIntakeResponse>;
  lease(executorId: string, input: CompanyAILeaseRequest): Promise<CompanyAILeaseResponse>;
  session(executorId: string, input: CompanyAISessionRequest): Promise<CompanyAISessionResponse>;
  custody(executorId: string, input: CompanyAICustodyRequest): Promise<CompanyAICustodyResponse>;
  agent(executorId: string, input: CompanyAIAgentRequest): Promise<CompanyAIAgentResponse>;
  invocations(executorId: string, input: CompanyAIInvocationRequest): Promise<CompanyAIInvocationResponse>;
  context(executorId: string, input: CompanyAIContextRequest): Promise<CompanyAIContextResponse>;
  publishCheck(input: CompanyAIPublishCheckRequest): Promise<CompanyAIPublishCheckResponse>;
  proactive(executorId: string, input: CompanyAIProactiveRequest):
    Promise<CompanyAIProactiveClaimResponse | CompanyAIProactiveSettleResponse>;
}

/** Additive channel-roster/1; fetched only for a live task's server-derived channel. */
export const CompanyAIChannelRosterSchema = z.object({
  schemaVersion: z.literal(1), companyId: uuid, channelId: uuid,
  members: z.array(z.object({
    userId: matrixUserId, handle: z.string().max(255).nullable(),
    kind: z.enum(["human", "assistant"]), role: z.string().min(1).max(64),
  }).strict()),
}).strict();
