import { z } from "zod";
import { AgentHomeExecutorLeaseFenceSchema, AgentHomeExecutorSignedMetaSchema } from "./agent-home-placement.js";
import { ControllerJobFireRequestSchema, ControllerJobFireResponseSchema } from "./scheduled-jobs.js";
import { OccurrenceOutcomeReceiptSchema } from "./occurrence-outcome.js";
export const MAC_JOB_SIGNATURE_ACTIONS = {
    "job-snapshot": "MacJobSnapshot", "job-fire": "MacJobFire", "job-occurrence": "MacJobOccurrence", "job-grant": "MacJobGrant",
};
const uuid = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const room = z.string().regex(/^![!-~]+$/u).max(1024);
const event = z.string().regex(/^\$[!-~]+$/u).max(1024);
const outcome = z.enum(["answered", "stopped", "failed", "uncertain"]);
const common = { executorId: uuid, protocol: z.literal(3) };
export const MacJobOccurrenceRequestSchema = z.discriminatedUnion("operation", [
    z.object({ ...common, operation: z.literal("claim"), leaseToken: uuid,
        scheduleId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u), occurrenceAt: integer,
        definitionDigest: digest, catchupWindowMs: integer.min(120000).max(7200000), roomId: room }).strict(),
    z.object({ ...common, operation: z.literal("dispatch"), leaseToken: uuid, occurrenceId: uuid }).strict(),
    z.object({ ...common, operation: z.literal("complete"), occurrenceId: uuid, outcome,
        usage: z.object({ computeSeconds: integer.max(86400) }).strict() }).strict(),
    z.object({ ...common, operation: z.literal("published"), occurrenceId: uuid, publishedEvent: event }).strict(),
]);
const envelope = (request) => z.object({
    meta: AgentHomeExecutorSignedMetaSchema.extend({ signer: z.literal("mac_executor") }).strict(),
    home: AgentHomeExecutorLeaseFenceSchema, request,
}).strict().refine(v => v.meta.expiresAt > v.meta.issuedAt && v.meta.expiresAt <= v.meta.issuedAt + 7200000, { message: "signed lifetime must be positive and at most two hours" });
export const MacJobFireEnvelopeSchema = envelope(ControllerJobFireRequestSchema);
export const MacJobOccurrenceEnvelopeSchema = envelope(MacJobOccurrenceRequestSchema);
// The model token is signed in the body, while Authorization remains the MAS owner bearer.
export const MacJobGrantEnvelopeSchema = envelope(z.object({ token }).strict());
export const MacJobPlacementReasonSchema = z.enum([
    "stale_home_epoch", "stale_executor_term", "wrong_lease", "lease_expired", "wrong_signer_location", "move_in_progress",
]);
export const MacJobRefusalSchema = z.union([
    z.object({ profile: z.literal("atum.mac-job-fire/1"), code: z.literal("lease_lost"),
        detail: z.object({ kind: z.literal("placement_authority"), reason: MacJobPlacementReasonSchema }).strict() }).strict(),
    z.object({ profile: z.literal("atum.mac-job-fire/1"),
        // `busy` (0215): the agent's own running work holds admission; retry with a fresh signed envelope.
        code: z.enum(["matrix_invalid", "denied", "not_found", "conflict", "busy", "unavailable"]) }).strict(),
]);
const modelCommon = { expiresAt: integer, aliases: z.array(z.string().min(1).max(256)).min(1).max(64),
    ceilingMicroProtons: integer, funding: z.enum(["trial", "wallet"]), alias: z.string().min(1).max(256),
    model: z.string().min(1).max(256), contextBudget: integer, outputBudget: integer, maxTurnMicroProtons: integer };
const policy = { effort: z.string().min(1).max(64), policyDigest: digest };
const google = { googlePolicy: z.literal("limited_use_v1"), latchState: z.enum(["eligible", "latched"]) };
export const MacJobModelGrantSchema = z.union([
    z.object({ ...modelCommon, ...policy, token }).strict(),
    z.object({ ...modelCommon, ...google, token }).strict(),
    z.object({ ...modelCommon, ...policy, token, funding: z.literal("subscription"),
        source: z.literal("opencode_go"), provider: z.literal("opencode_go"), connectionRevision: integer }).strict(),
    z.object({ ...modelCommon, ...policy, token, funding: z.literal("subscription"),
        source: z.literal("chatgpt_plan"), provider: z.literal("openai-codex"), relayRevision: integer, relayDeviceServiceId: uuid }).strict(),
]);
const active = { ...modelCommon, state: z.literal("active"), owner: uuid, agentPrincipal: uuid, reservationId: uuid };
export const MacJobGrantResultSchema = z.union([
    z.object({ state: z.literal("revoked") }).strict(),
    z.object({ ...active, ...policy }).strict(), z.object({ ...active, ...google }).strict(),
]);
export const MacJobOccurrenceResultSchema = z.object({
    occurrenceId: uuid, state: z.enum(["claimed", "dispatched", "completed", "skipped"]),
    scheduleId: z.string().min(1).max(64), occurrenceAt: integer, agentPrincipal: uuid, executorId: uuid,
    roomId: room, expiresAt: integer.optional(), skipReason: z.enum(["missed", "unfunded", "capacity_unavailable", "stopped", "revoked", "access_ended", "released"]).optional(),
    transactionId: z.string().min(1).max(1024).optional(), publishedEvent: event.optional(), outcome: outcome.optional(),
    deliveryDisposition: z.enum(["silent", "delivered"]).optional(),
    resume: z.object({ attempt: integer, effect: z.enum(["none", "read_only", "side_effect_possible"]),
        tools: z.array(z.string().max(256)).max(256) }).strict().optional(),
    occurrenceOutcome: OccurrenceOutcomeReceiptSchema.optional(),
    budget: z.object({ reservationId: uuid, funding: z.enum(["trial", "wallet"]), ceilingMicroProtons: integer,
        computeSeconds: integer, firstAdmission: z.boolean() }).strict().optional(),
    grants: z.object({ model: MacJobModelGrantSchema }).strict().optional(),
}).strict().refine(v => (v.budget === undefined) === (v.grants === undefined), { message: "budget and grant are paired" });
export const MacJobFireResponseSchema = z.union([ControllerJobFireResponseSchema, MacJobRefusalSchema]);
export const MacJobOccurrenceResponseSchema = z.union([MacJobOccurrenceResultSchema, MacJobRefusalSchema]);
export const MacJobGrantResponseSchema = z.union([MacJobGrantResultSchema, MacJobRefusalSchema]);
export const MacJobSnapshotEnvelopeSchema = z.object({ meta: AgentHomeExecutorSignedMetaSchema.extend({ signer: z.literal("mac_executor") }).strict(), home: AgentHomeExecutorLeaseFenceSchema, profile: z.literal("atum.mac-job-snapshot/1") }).strict().refine(v => v.meta.expiresAt > v.meta.issuedAt && v.meta.expiresAt <= v.meta.issuedAt + 7200000);
export const MacJobSnapshotResultSchema = z.object({
    profile: z.literal("atum.mac-job-snapshot/1"), selected: z.boolean(),
    generation: digest.nullable(), managedJobIds: z.array(z.string().min(1).max(64)),
}).strict().refine(v => v.selected ? v.generation !== null : v.generation === null && v.managedJobIds.length === 0);
export const MacJobSnapshotResponseSchema = z.union([MacJobSnapshotResultSchema, MacJobRefusalSchema]);
export const MAC_JOB_MODEL_SIGNATURE_HEADER = "x-atum-mac-job-signature";
export const MacJobModelEnvelopeSchema = envelope(z.object({
    method: z.literal("POST"), path: z.string().regex(/^\/(?:v1\/)?chat\/completions$/u), grantDigest: digest,
}).strict());
