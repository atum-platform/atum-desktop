import { z } from "zod";

import { sha256Schema, uuidSchema } from "./internal-schemas.js";

/** Frozen by `spec/company-private-cos/v1`. */
export const COMPANY_PRIVATE_COS_PROFILE = "atum.company-private-cos/1" as const;
export const COMPANY_PRIVATE_COS_ASYNC_PROFILE = "atum.company-private-cos/1.1" as const;
export const COMPANY_PRIVATE_COS_INTEGRATION_PROFILE = "atum.company-private-cos/1.2" as const;
export const COMPANY_PRIVATE_COS_LOCALE_PROFILE = "atum.company-private-cos/1.3" as const;
export const COMPANY_PRIVATE_COS_SCHEMA_VERSION = 1 as const;
export const COMPANY_PRIVATE_COS_CAPABILITY = "company.private-cos" as const;
export const COMPANY_PRIVATE_COS_EXECUTION_CAPABILITY = "company_private_cos" as const;
export const COMPANY_PRIVATE_COS_EXECUTOR_PROFILE = "company_private_cos_restricted" as const;
export const COMPANY_PRIVATE_COS_FUNDING_KIND = "company_wallet" as const;
export const COMPANY_PRIVATE_COS_PURGE_AFTER_DAYS = 30 as const;
export const COMPANY_PRIVATE_COS_PURGE_AFTER_MS = 2_592_000_000 as const;
export const COMPANY_PRIVATE_COS_DISPLAY_NAME = "Chief of Staff" as const;
export const COMPANY_PRIVATE_COS_RETENTION_NOTICE =
  "Your private Chief of Staff is retired when you leave. After the 30-day retention period, its private home and memory are erased automatically, and backup copies are removed as they expire. We record completion only after we verify every copy is gone." as const;
export const COMPANY_PRIVATE_COS_SUPPORTED_PROFILES = [
  COMPANY_PRIVATE_COS_PROFILE,
  COMPANY_PRIVATE_COS_ASYNC_PROFILE,
  COMPANY_PRIVATE_COS_INTEGRATION_PROFILE,
  COMPANY_PRIVATE_COS_LOCALE_PROFILE,
] as const;
export const COMPANY_PRIVATE_COS_WIRE_HEADER = "Atum-Company-Wire" as const;
export const COMPANY_PRIVATE_COS_WIRE_VALUE_V11 = "1.1" as const;
export const COMPANY_PRIVATE_COS_WIRE_VALUE_V12 = "1.2" as const;
export const COMPANY_PRIVATE_COS_WIRE_VALUE = "1.3" as const;

const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const matrixUserId = z.string().min(4).max(512).regex(/^@[!-9;-~]{1,255}:[!-~]{1,255}$/u);
const roomId = z.string().min(4).max(512).regex(/^![!-9;-~]{1,255}:[!-~]{1,255}$/u);
const eventId = z.string().min(2).max(512).regex(/^[$][!-~]+$/u);

export const CompanyPrivateCosPairSchema = z.object({
  companyPrincipal: uuidSchema,
  memberPrincipal: uuidSchema,
  membershipIncarnation: uuidSchema,
}).strict();
export type CompanyPrivateCosPair = z.infer<typeof CompanyPrivateCosPairSchema>;

export const CompanyPrivateCosScopeSchema = z.object({
  pair: CompanyPrivateCosPairSchema,
  authorityEpoch: positiveInteger,
  contextEpoch: positiveInteger,
  homeGeneration: positiveInteger,
}).strict();
export type CompanyPrivateCosScope = z.infer<typeof CompanyPrivateCosScopeSchema>;

export const CompanyPrivateCosCapabilityV1Schema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  profile: z.literal(COMPANY_PRIVATE_COS_PROFILE),
  capability: z.literal(COMPANY_PRIVATE_COS_CAPABILITY),
  displayName: z.literal(COMPANY_PRIVATE_COS_DISPLAY_NAME),
  teamDmPosition: z.literal(2),
  lazyCreation: z.literal(true),
  fundingKind: z.literal(COMPANY_PRIVATE_COS_FUNDING_KIND),
  separatePrice: z.literal(false),
  purgeAfterDays: z.literal(COMPANY_PRIVATE_COS_PURGE_AFTER_DAYS),
  userExport: z.literal(false),
}).strict();
export type CompanyPrivateCosCapabilityV1 = z.infer<typeof CompanyPrivateCosCapabilityV1Schema>;

export const CompanyPrivateCosCapabilityV11Schema = z.object({
  schemaVersion: z.literal(2),
  profile: z.literal(COMPANY_PRIVATE_COS_ASYNC_PROFILE),
  capability: z.literal(COMPANY_PRIVATE_COS_CAPABILITY),
  supportedProfiles: z.tuple([
    z.literal(COMPANY_PRIVATE_COS_PROFILE),
    z.literal(COMPANY_PRIVATE_COS_ASYNC_PROFILE),
  ]),
  wire: z.object({
    header: z.literal(COMPANY_PRIVATE_COS_WIRE_HEADER),
    value: z.literal(COMPANY_PRIVATE_COS_WIRE_VALUE_V11),
  }).strict(),
  displayName: z.literal(COMPANY_PRIVATE_COS_DISPLAY_NAME),
  teamDmPosition: z.literal(2),
  lazyCreation: z.literal(true),
  fundingKind: z.literal(COMPANY_PRIVATE_COS_FUNDING_KIND),
  separatePrice: z.literal(false),
  purgeAfterDays: z.literal(COMPANY_PRIVATE_COS_PURGE_AFTER_DAYS),
  userExport: z.literal(false),
}).strict();
export type CompanyPrivateCosCapabilityV11 = z.infer<typeof CompanyPrivateCosCapabilityV11Schema>;

export const CompanyPrivateCosCapabilityV12Schema = z.object({
  schemaVersion: z.literal(3),
  profile: z.literal(COMPANY_PRIVATE_COS_INTEGRATION_PROFILE),
  capability: z.literal(COMPANY_PRIVATE_COS_CAPABILITY),
  supportedProfiles: z.tuple([
    z.literal(COMPANY_PRIVATE_COS_PROFILE),
    z.literal(COMPANY_PRIVATE_COS_ASYNC_PROFILE),
    z.literal(COMPANY_PRIVATE_COS_INTEGRATION_PROFILE),
  ]),
  wire: z.object({
    header: z.literal(COMPANY_PRIVATE_COS_WIRE_HEADER),
    value: z.literal(COMPANY_PRIVATE_COS_WIRE_VALUE_V12),
  }).strict(),
  displayName: z.literal(COMPANY_PRIVATE_COS_DISPLAY_NAME),
  teamDmPosition: z.literal(2),
  lazyCreation: z.literal(true),
  fundingKind: z.literal(COMPANY_PRIVATE_COS_FUNDING_KIND),
  separatePrice: z.literal(false),
  purgeAfterDays: z.literal(COMPANY_PRIVATE_COS_PURGE_AFTER_DAYS),
  userExport: z.literal(false),
  roomType: z.literal("io.atum.assistant"),
  roomName: z.literal(COMPANY_PRIVATE_COS_DISPLAY_NAME),
  roomEncrypted: z.literal(false),
  greetingVersion: z.literal(2),
}).strict();
export type CompanyPrivateCosCapabilityV12 = z.infer<typeof CompanyPrivateCosCapabilityV12Schema>;

export const CompanyPrivateCosCapabilityV13Schema = z.object({
  ...CompanyPrivateCosCapabilityV12Schema.shape,
  schemaVersion: z.literal(4),
  profile: z.literal(COMPANY_PRIVATE_COS_LOCALE_PROFILE),
  supportedProfiles: z.tuple([
    z.literal(COMPANY_PRIVATE_COS_PROFILE),
    z.literal(COMPANY_PRIVATE_COS_ASYNC_PROFILE),
    z.literal(COMPANY_PRIVATE_COS_INTEGRATION_PROFILE),
    z.literal(COMPANY_PRIVATE_COS_LOCALE_PROFILE),
  ]),
  wire: z.object({ header: z.literal(COMPANY_PRIVATE_COS_WIRE_HEADER),
    value: z.literal(COMPANY_PRIVATE_COS_WIRE_VALUE) }).strict(),
  ensureLocale: z.literal(true),
}).strict();
export type CompanyPrivateCosCapabilityV13 = z.infer<typeof CompanyPrivateCosCapabilityV13Schema>;

export const COMPANY_PRIVATE_COS_CAPABILITY_BODY = Object.freeze({
  schemaVersion: 4,
  profile: COMPANY_PRIVATE_COS_LOCALE_PROFILE,
  capability: COMPANY_PRIVATE_COS_CAPABILITY,
  supportedProfiles: COMPANY_PRIVATE_COS_SUPPORTED_PROFILES,
  wire: { header: COMPANY_PRIVATE_COS_WIRE_HEADER, value: COMPANY_PRIVATE_COS_WIRE_VALUE },
  displayName: COMPANY_PRIVATE_COS_DISPLAY_NAME,
  teamDmPosition: 2,
  lazyCreation: true,
  fundingKind: COMPANY_PRIVATE_COS_FUNDING_KIND,
  separatePrice: false,
  purgeAfterDays: COMPANY_PRIVATE_COS_PURGE_AFTER_DAYS,
  userExport: false,
  roomType: "io.atum.assistant",
  roomName: COMPANY_PRIVATE_COS_DISPLAY_NAME,
  roomEncrypted: false,
  greetingVersion: 2,
  ensureLocale: true,
} as const);
/** Current capability advertisement; v1/v1.1 remain available through explicit schemas. */
export const CompanyPrivateCosCapabilitySchema = CompanyPrivateCosCapabilityV13Schema;
export type CompanyPrivateCosCapability = z.infer<typeof CompanyPrivateCosCapabilitySchema>;

const viewBase = {
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  pair: CompanyPrivateCosPairSchema,
};

export const CompanyPrivateCosUncreatedViewSchema = z.object({
  ...viewBase,
  state: z.literal("uncreated"),
  greetingState: z.literal("pending"),
}).strict();

export const CompanyPrivateCosBindingSchema = z.object({
  scope: CompanyPrivateCosScopeSchema,
  agentPrincipal: uuidSchema,
  agentUserId: matrixUserId,
  executorId: uuidSchema,
  homeId: uuidSchema,
  roomId,
  storeGeneration: positiveInteger,
  profileDigest: sha256Schema,
}).strict();
export type CompanyPrivateCosBinding = z.infer<typeof CompanyPrivateCosBindingSchema>;

export const CompanyPrivateCosPreparingViewSchema = z.object({
  ...viewBase,
  state: z.literal("preparing"),
  greetingState: z.enum(["pending", "publishing"]),
  binding: CompanyPrivateCosBindingSchema,
}).strict();

export const CompanyPrivateCosReadyViewSchema = z.object({
  ...viewBase,
  state: z.literal("ready"),
  greetingState: z.enum(["pending", "published"]),
  binding: CompanyPrivateCosBindingSchema,
}).strict();

const samePair = (left: CompanyPrivateCosPair, right: CompanyPrivateCosPair): boolean =>
  left.companyPrincipal === right.companyPrincipal
  && left.memberPrincipal === right.memberPrincipal
  && left.membershipIncarnation === right.membershipIncarnation;

export const CompanyPrivateCosViewSchema = z.discriminatedUnion("state", [
  CompanyPrivateCosUncreatedViewSchema,
  CompanyPrivateCosPreparingViewSchema,
  CompanyPrivateCosReadyViewSchema,
]).superRefine((value, context) => {
  if (value.state !== "uncreated" && !samePair(value.pair, value.binding.scope.pair)) {
    context.addIssue({ code: "custom", path: ["binding", "scope", "pair"], message: "view and binding pair must match" });
  }
});
export type CompanyPrivateCosView = z.infer<typeof CompanyPrivateCosViewSchema>;

export const CompanyPrivateCosEnsureRequestSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  requestId: uuidSchema,
  action: z.literal("ensure"),
  trigger: z.enum(["dm_open", "first_company_visit"]),
  locale: z.enum(["en", "vi", "ja", "zh", "zh-hant"]).optional(),
}).strict();
export type CompanyPrivateCosEnsureRequest = z.infer<typeof CompanyPrivateCosEnsureRequestSchema>;

export const CompanyPrivateCosEnsureResponseSchema = z.discriminatedUnion("state", [
  CompanyPrivateCosPreparingViewSchema,
  CompanyPrivateCosReadyViewSchema,
]).superRefine((value, context) => {
  if (!samePair(value.pair, value.binding.scope.pair)) {
    context.addIssue({ code: "custom", path: ["binding", "scope", "pair"], message: "view and binding pair must match" });
  }
});
export type CompanyPrivateCosEnsureResponse = z.infer<typeof CompanyPrivateCosEnsureResponseSchema>;

/**
 * Additive 0.7.78 response for asynchronous platform provisioning. V1's
 * `ensure.response` remains frozen and still requires a fully materialized
 * preparing binding; the Shell returns this explicitly versioned shape while
 * the controller has not bound Matrix identity, room and home yet.
 */
export const CompanyPrivateCosEnsureAcceptedSchema = z.object({
  schemaVersion: z.literal(2),
  profile: z.literal(COMPANY_PRIVATE_COS_ASYNC_PROFILE),
  state: z.literal("preparing"),
  pair: CompanyPrivateCosPairSchema,
  greetingState: z.literal("pending"),
  operationId: uuidSchema,
}).strict();
export type CompanyPrivateCosEnsureAccepted = z.infer<typeof CompanyPrivateCosEnsureAcceptedSchema>;

const greetingBase = {
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  pair: CompanyPrivateCosPairSchema,
  intentId: uuidSchema,
  welcomeVersion: z.literal(1),
  locale: z.enum(["en", "vi", "ja", "zh", "zh-hant"]),
  outboxTransactionId: uuidSchema,
};

export const CompanyPrivateCosGreetingRecordSchema = z.discriminatedUnion("state", [
  z.object({
    ...greetingBase,
    state: z.literal("pending"),
    publicationCount: z.literal(0),
    publishedEventId: z.null(),
    replayed: z.literal(false),
  }).strict(),
  z.object({
    ...greetingBase,
    state: z.literal("published"),
    publicationCount: z.literal(1),
    publishedEventId: eventId,
    replayed: z.boolean(),
  }).strict(),
]);
export type CompanyPrivateCosGreetingRecord = z.infer<typeof CompanyPrivateCosGreetingRecordSchema>;

export const CompanyPrivateCosHomeDescriptorSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  scope: CompanyPrivateCosScopeSchema,
  homeId: uuidSchema,
  storeGeneration: positiveInteger,
  namespaceDigest: sha256Schema,
  encryption: z.literal("existing_encrypted_custody"),
  writer: z.literal("serialized_lease_holder"),
  contentRetention: z.object({
    policy: z.literal("retired_private_cos"),
    purgeAfterDays: z.literal(COMPANY_PRIVATE_COS_PURGE_AFTER_DAYS),
    userExport: z.literal("none"),
  }).strict(),
  financeReceiptRetention: z.literal("separate"),
}).strict();
export type CompanyPrivateCosHomeDescriptor = z.infer<typeof CompanyPrivateCosHomeDescriptorSchema>;

const retirementBase = {
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  pair: CompanyPrivateCosPairSchema,
  homeId: uuidSchema,
  homeGeneration: positiveInteger,
  retiredAtMs: nonnegativeInteger,
  purgeAtMs: nonnegativeInteger,
  access: z.literal("denied"),
  restoreOnRejoin: z.literal(false),
  userExport: z.literal("none"),
  financeReceipts: z.literal("retained_separately"),
};

export const CompanyPrivateCosRetirementRecordSchema = z.object({
  ...retirementBase,
  state: z.literal("retired"),
  homeState: z.literal("retained_pending_purge"),
  memoryState: z.literal("retained_pending_purge"),
  sessions: z.literal("revoked"),
  schedules: z.literal("disabled"),
}).strict().superRefine((value, context) => {
  if (value.purgeAtMs - value.retiredAtMs !== COMPANY_PRIVATE_COS_PURGE_AFTER_MS) {
    context.addIssue({ code: "custom", path: ["purgeAtMs"], message: "private content purges exactly 30 days after retirement" });
  }
});
export type CompanyPrivateCosRetirementRecord = z.infer<typeof CompanyPrivateCosRetirementRecordSchema>;

export const CompanyPrivateCosPurgeReceiptSchema = z.object({
  ...retirementBase,
  state: z.literal("purged"),
  purgedAtMs: nonnegativeInteger,
  homeState: z.literal("deleted"),
  memoryState: z.literal("deleted"),
  financeReceipts: z.literal("retained_separately"),
}).strict().superRefine((value, context) => {
  if (value.purgeAtMs - value.retiredAtMs !== COMPANY_PRIVATE_COS_PURGE_AFTER_MS) {
    context.addIssue({ code: "custom", path: ["purgeAtMs"], message: "private content purges exactly 30 days after retirement" });
  }

  if (value.purgedAtMs < value.purgeAtMs) {
    context.addIssue({ code: "custom", path: ["purgedAtMs"], message: "purge cannot complete before the retention deadline" });
  }
});
export type CompanyPrivateCosPurgeReceipt = z.infer<typeof CompanyPrivateCosPurgeReceiptSchema>;

export const CompanyPrivateCosRejoinRecordSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  previous: z.object({
    pair: CompanyPrivateCosPairSchema,
    homeId: uuidSchema,
    homeGeneration: positiveInteger,
    state: z.literal("retired"),
    access: z.literal("denied"),
    roomBinding: z.literal("tombstoned"),
  }).strict(),
  current: z.object({
    pair: CompanyPrivateCosPairSchema,
    state: z.literal("uncreated"),
    greetingState: z.literal("pending"),
  }).strict(),
  restoration: z.literal("forbidden"),
  schedulesResume: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.previous.pair.companyPrincipal !== value.current.pair.companyPrincipal) {
    context.addIssue({ code: "custom", path: ["current", "pair", "companyPrincipal"], message: "rejoin keeps the logical company pair" });
  }

  if (value.previous.pair.memberPrincipal !== value.current.pair.memberPrincipal) {
    context.addIssue({ code: "custom", path: ["current", "pair", "memberPrincipal"], message: "rejoin keeps the logical member pair" });
  }

  if (value.previous.pair.membershipIncarnation === value.current.pair.membershipIncarnation) {
    context.addIssue({ code: "custom", path: ["current", "pair", "membershipIncarnation"], message: "rejoin requires a fresh incarnation" });
  }
});
export type CompanyPrivateCosRejoinRecord = z.infer<typeof CompanyPrivateCosRejoinRecordSchema>;

export const CompanyPrivateCosExecutorProfileSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  capability: z.literal(COMPANY_PRIVATE_COS_EXECUTION_CAPABILITY),
  runtime: z.literal("native_hermes"),
  command: z.literal("prompt.submit"),
  scope: CompanyPrivateCosScopeSchema,
  profileDigest: sha256Schema,
  funding: z.object({
    kind: z.literal(COMPANY_PRIVATE_COS_FUNDING_KIND),
    companyPrincipal: uuidSchema,
    maxMicroProtons: positiveInteger,
    memberPrivateCapMicroProtons: positiveInteger,
  }).strict(),
  sandbox: z.object({
    profile: z.literal(COMPANY_PRIVATE_COS_EXECUTOR_PROFILE),
    homeMount: z.object({
      kind: z.literal("company_private_cos_home"),
      homeId: uuidSchema,
      mode: z.literal("read_write"),
    }).strict(),
    tools: z.tuple([]),
    personalMounts: z.literal(false),
    personalTools: z.literal(false),
    personalGrants: z.literal(false),
    shell: z.literal(false),
    network: z.literal(false),
    schedules: z.literal(false),
    backgroundReview: z.literal(false),
    companySourceRetrieval: z.literal(false),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.funding.companyPrincipal !== value.scope.pair.companyPrincipal) {
    context.addIssue({ code: "custom", path: ["funding", "companyPrincipal"], message: "the pair company is the only payer" });
  }

  if (value.funding.memberPrivateCapMicroProtons > value.funding.maxMicroProtons) {
    context.addIssue({ code: "custom", path: ["funding", "memberPrivateCapMicroProtons"], message: "member allowance cannot exceed the bounded grant" });
  }
});
export type CompanyPrivateCosExecutorProfile = z.infer<typeof CompanyPrivateCosExecutorProfileSchema>;

export const CompanyPrivateCosAdmissionDeniedSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  decision: z.literal("denied"),
  code: z.literal("pair_mismatch"),
  requesterPrincipal: uuidSchema,
  pair: CompanyPrivateCosPairSchema,
  homeOpened: z.literal(false),
  modelStarted: z.literal(false),
  grantIssued: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.requesterPrincipal === value.pair.memberPrincipal) {
    context.addIssue({ code: "custom", path: ["requesterPrincipal"], message: "pair_mismatch applies only to a different member" });
  }
});
export type CompanyPrivateCosAdmissionDenied = z.infer<typeof CompanyPrivateCosAdmissionDeniedSchema>;

export const CompanyPrivateCosAllowanceReservationSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  runId: uuidSchema,
  pair: CompanyPrivateCosPairSchema,
  fundingKind: z.literal(COMPANY_PRIVATE_COS_FUNDING_KIND),
  walletCompanyPrincipal: uuidSchema,
  pricing: z.literal("existing_model_tariff"),
  separatePrice: z.literal(false),
  reservedMicroProtons: positiveInteger,
  companyDailyCapMicroProtons: positiveInteger,
  memberPrivateCapMicroProtons: positiveInteger,
  memberWalletDebited: z.literal(false),
  personalFallback: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.walletCompanyPrincipal !== value.pair.companyPrincipal) {
    context.addIssue({ code: "custom", path: ["walletCompanyPrincipal"], message: "private runs debit the pair company wallet" });
  }

  if (value.reservedMicroProtons > value.companyDailyCapMicroProtons
      || value.reservedMicroProtons > value.memberPrivateCapMicroProtons) {
    context.addIssue({ code: "custom", path: ["reservedMicroProtons"], message: "reservation must fit both finite caps" });
  }
});
export type CompanyPrivateCosAllowanceReservation = z.infer<typeof CompanyPrivateCosAllowanceReservationSchema>;

export const CompanyPrivateCosOwnerReceiptSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  runId: uuidSchema,
  taskId: uuidSchema,
  pair: CompanyPrivateCosPairSchema,
  executorId: uuidSchema,
  contextEpoch: positiveInteger,
  homeGeneration: positiveInteger,
  authorityEpoch: positiveInteger,
  reservationId: uuidSchema,
  reservedMicroProtons: positiveInteger,
  settledMicroProtons: nonnegativeInteger,
  state: z.enum(["reserved", "running", "stopped", "settled", "uncertain"]),
  verifiedEventId: eventId,
  homeCommitId: uuidSchema.nullable(),
  outboxTransactionId: uuidSchema.nullable(),
  publishedEventId: eventId.nullable(),
  sourceLinks: z.array(z.object({
    sourceId: uuidSchema,
    revisionDigest: sha256Schema,
  }).strict()).max(40),
}).strict();
export type CompanyPrivateCosOwnerReceipt = z.infer<typeof CompanyPrivateCosOwnerReceiptSchema>;

export const CompanyPrivateCosUnfundedStopReceiptSchema = z.object({
  schemaVersion: z.literal(2),
  profile: z.literal(COMPANY_PRIVATE_COS_ASYNC_PROFILE),
  runId: uuidSchema,
  taskId: uuidSchema,
  pair: CompanyPrivateCosPairSchema,
  executorId: uuidSchema,
  contextEpoch: positiveInteger,
  homeGeneration: positiveInteger,
  authorityEpoch: positiveInteger,
  state: z.literal("stopped"),
  verifiedEventId: eventId,
  funding: z.object({
    state: z.literal("not_reserved"),
    reservationId: z.null(),
    reservedMicroProtons: z.literal(0),
    settledMicroProtons: z.literal(0),
  }).strict(),
  homeCommitId: uuidSchema.nullable(),
  outboxTransactionId: uuidSchema.nullable(),
  publishedEventId: eventId.nullable(),
  sourceLinks: z.tuple([]),
}).strict();
export type CompanyPrivateCosUnfundedStopReceipt = z.infer<typeof CompanyPrivateCosUnfundedStopReceiptSchema>;

export const CompanyPrivateCosAdminSpendSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  companyPrincipal: uuidSchema,
  localDate: z.iso.date(),
  totals: z.array(z.object({
    memberPrincipal: uuidSchema,
    category: z.literal("private_cos"),
    reservedMicroProtons: nonnegativeInteger,
    settledMicroProtons: nonnegativeInteger,
    runCount: nonnegativeInteger,
  }).strict()).max(10_000),
}).strict();
export type CompanyPrivateCosAdminSpend = z.infer<typeof CompanyPrivateCosAdminSpendSchema>;

/** P-T5 native route contracts added by protocol 0.7.78. */
export const CompanyPrivateCosStopRequestSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  requestId: uuidSchema,
}).strict();
export type CompanyPrivateCosStopRequest = z.infer<typeof CompanyPrivateCosStopRequestSchema>;

export const CompanyPrivateCosBudgetRequestSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  requestId: uuidSchema,
  memberPrincipal: uuidSchema,
  expectedRevision: positiveInteger,
  allowanceMicroProtons: positiveInteger,
}).strict();
export type CompanyPrivateCosBudgetRequest = z.infer<typeof CompanyPrivateCosBudgetRequestSchema>;

export const CompanyPrivateCosBudgetResponseSchema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  companyPrincipal: uuidSchema,
  memberPrincipal: uuidSchema,
  allowanceMicroProtons: positiveInteger,
  revision: positiveInteger,
}).strict();
export type CompanyPrivateCosBudgetResponse = z.infer<typeof CompanyPrivateCosBudgetResponseSchema>;

export const CompanyPrivateCosIdentityWorkSchema = z.object({
  companyPrincipal: uuidSchema,
  memberPrincipal: uuidSchema,
  membershipIncarnation: uuidSchema,
  agentPrincipal: uuidSchema,
  executorId: uuidSchema,
  homeId: uuidSchema,
  username: z.string().regex(/^agent-[a-f0-9]{20}$/u),
  displayName: z.literal(COMPANY_PRIVATE_COS_DISPLAY_NAME),
  authorityEpoch: positiveInteger,
}).strict();

export const CompanyPrivateCosWorkPageV11Schema = z.object({
  schemaVersion: z.literal(COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  items: z.array(CompanyPrivateCosIdentityWorkSchema).max(100),
  purge: z.array(z.object({
    companyPrincipal: uuidSchema,
    memberPrincipal: uuidSchema,
    membershipIncarnation: uuidSchema,
    agentPrincipal: uuidSchema,
    executorId: uuidSchema,
    homeId: uuidSchema,
    purgeAt: z.iso.datetime({ offset: true }),
  }).strict()).max(100),
  nextCursor: uuidSchema.nullable(),
}).strict();
export const CompanyPrivateCosTeardownWorkSchema = z.object({
  companyPrincipal: uuidSchema,
  memberPrincipal: uuidSchema,
  membershipIncarnation: uuidSchema,
  agentPrincipal: uuidSchema,
  executorId: uuidSchema,
  homeId: uuidSchema,
}).strict();
export const CompanyPrivateCosWorkPageV12Schema = z.object({
  schemaVersion: z.literal(2),
  items: z.array(CompanyPrivateCosIdentityWorkSchema).max(100),
  teardown: z.array(CompanyPrivateCosTeardownWorkSchema).max(100),
  purge: CompanyPrivateCosWorkPageV11Schema.shape.purge,
  nextCursor: uuidSchema.nullable(),
}).strict();
export const CompanyPrivateCosWorkPageSchema = z.union([
  CompanyPrivateCosWorkPageV11Schema,
  CompanyPrivateCosWorkPageV12Schema,
]);
export type CompanyPrivateCosWorkPage = z.infer<typeof CompanyPrivateCosWorkPageSchema>;
