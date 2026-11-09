import { z } from "zod";
export const OCCURRENCE_OUTCOME_PROFILE = "atum.occurrence-outcome/1";
export const OCCURRENCE_OUTCOME_STAGES = [
    "policy", "script", "preflight", "model", "delivery",
];
export const OCCURRENCE_OUTCOME_CODES = [
    "completed", "legacy_unclassified", "disabled", "not_due", "owner_active", "pending_work",
    "missing_time_zone", "audience_unavailable", "source_denied", "source_unavailable", "source_failed",
    "no_change", "model_budget_exhausted", "compute_budget_exhausted", "unfunded", "lease_lost",
    "definition_stale", "tools_policy_mismatch", "script_failed", "script_timeout", "preflight_failed",
    "model_failed", "result_invalid", "submission_unknown", "delivery_pending", "delivery_failed", "stopped",
];
export const OCCURRENCE_OUTCOME_DISPOSITIONS = [
    "deferred", "silent", "offer", "delivered", "failed", "stopped", "uncertain",
];
export const OccurrenceOutcomeStageSchema = z.enum(OCCURRENCE_OUTCOME_STAGES);
export const OccurrenceOutcomeCodeSchema = z.enum(OCCURRENCE_OUTCOME_CODES);
export const OccurrenceOutcomeDispositionSchema = z.enum(OCCURRENCE_OUTCOME_DISPOSITIONS);
const nativeIdentifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const NativeOccurrenceExecutionSchema = z.object({
    jobId: nativeIdentifier,
    executionId: nativeIdentifier,
}).strict();
export const OccurrenceOutcomeReceiptSchema = z.object({
    profile: z.literal(OCCURRENCE_OUTCOME_PROFILE),
    stage: OccurrenceOutcomeStageSchema,
    code: OccurrenceOutcomeCodeSchema,
    retryable: z.boolean(),
    disposition: OccurrenceOutcomeDispositionSchema,
    native: NativeOccurrenceExecutionSchema.nullable(),
}).strict().superRefine((value, context) => {
    if (value.code === "completed" && !["silent", "offer", "delivered"].includes(value.disposition)) {
        context.addIssue({ code: "custom", path: ["disposition"], message: "completed work is silent, offered or delivered" });
    }
    if (["silent", "offer", "delivered"].includes(value.disposition) && value.code !== "completed" && value.code !== "no_change") {
        context.addIssue({ code: "custom", path: ["code"], message: "publication success requires a success code" });
    }
    if (value.disposition === "failed" && ["completed", "no_change"].includes(value.code)) {
        context.addIssue({ code: "custom", path: ["code"], message: "failed work requires a failure code" });
    }
});
const legacySkipCodes = Object.freeze({
    disabled: "disabled",
    not_due: "not_due",
    owner_active: "owner_active",
    pending_work: "pending_work",
    missing_time_zone: "missing_time_zone",
    home_unavailable: "audience_unavailable",
    unfunded: "unfunded",
    stopped: "stopped",
    revoked: "source_denied",
});
/**
 * Decode a persisted receipt without rewriting historical rows. New typed bytes
 * win. Terminal legacy rows receive one conservative compatibility projection;
 * live rows remain `null` because no outcome has happened yet.
 */
export function decodeOccurrenceOutcome(typed, legacy) {
    if (typed !== undefined && typed !== null)
        return OccurrenceOutcomeReceiptSchema.parse(typed);
    if (legacy.state === "skipped" || legacy.skipReason) {
        const code = legacySkipCodes[legacy.skipReason ?? ""] ?? "legacy_unclassified";
        return OccurrenceOutcomeReceiptSchema.parse({
            profile: OCCURRENCE_OUTCOME_PROFILE,
            stage: "policy",
            code,
            retryable: false,
            disposition: code === "stopped" ? "stopped" : "deferred",
            native: null,
        });
    }
    if (legacy.outcome === "answered") {
        return OccurrenceOutcomeReceiptSchema.parse({
            profile: OCCURRENCE_OUTCOME_PROFILE,
            stage: "delivery",
            code: "completed",
            retryable: false,
            disposition: legacy.deliveryDisposition === "silent" ? "silent" : "delivered",
            native: null,
        });
    }
    if (legacy.outcome === "stopped") {
        return OccurrenceOutcomeReceiptSchema.parse({
            profile: OCCURRENCE_OUTCOME_PROFILE,
            stage: "preflight",
            code: "stopped",
            retryable: false,
            disposition: "stopped",
            native: null,
        });
    }
    if (legacy.outcome === "failed" || legacy.outcome === "uncertain") {
        return OccurrenceOutcomeReceiptSchema.parse({
            profile: OCCURRENCE_OUTCOME_PROFILE,
            stage: "model",
            code: legacy.outcome === "uncertain" ? "submission_unknown" : "legacy_unclassified",
            retryable: false,
            disposition: legacy.outcome,
            native: null,
        });
    }
    return null;
}
