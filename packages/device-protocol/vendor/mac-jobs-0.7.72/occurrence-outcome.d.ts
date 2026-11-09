import { z } from "zod";
export declare const OCCURRENCE_OUTCOME_PROFILE: "atum.occurrence-outcome/1";
export declare const OCCURRENCE_OUTCOME_STAGES: readonly ["policy", "script", "preflight", "model", "delivery"];
export declare const OCCURRENCE_OUTCOME_CODES: readonly ["completed", "legacy_unclassified", "disabled", "not_due", "owner_active", "pending_work", "missing_time_zone", "audience_unavailable", "source_denied", "source_unavailable", "source_failed", "no_change", "model_budget_exhausted", "compute_budget_exhausted", "unfunded", "lease_lost", "definition_stale", "tools_policy_mismatch", "script_failed", "script_timeout", "preflight_failed", "model_failed", "result_invalid", "submission_unknown", "delivery_pending", "delivery_failed", "stopped"];
export declare const OCCURRENCE_OUTCOME_DISPOSITIONS: readonly ["deferred", "silent", "offer", "delivered", "failed", "stopped", "uncertain"];
export declare const OccurrenceOutcomeStageSchema: z.ZodEnum<{
    policy: "policy";
    script: "script";
    preflight: "preflight";
    model: "model";
    delivery: "delivery";
}>;
export declare const OccurrenceOutcomeCodeSchema: z.ZodEnum<{
    completed: "completed";
    legacy_unclassified: "legacy_unclassified";
    disabled: "disabled";
    not_due: "not_due";
    owner_active: "owner_active";
    pending_work: "pending_work";
    missing_time_zone: "missing_time_zone";
    audience_unavailable: "audience_unavailable";
    source_denied: "source_denied";
    source_unavailable: "source_unavailable";
    source_failed: "source_failed";
    no_change: "no_change";
    model_budget_exhausted: "model_budget_exhausted";
    compute_budget_exhausted: "compute_budget_exhausted";
    unfunded: "unfunded";
    lease_lost: "lease_lost";
    definition_stale: "definition_stale";
    tools_policy_mismatch: "tools_policy_mismatch";
    script_failed: "script_failed";
    script_timeout: "script_timeout";
    preflight_failed: "preflight_failed";
    model_failed: "model_failed";
    result_invalid: "result_invalid";
    submission_unknown: "submission_unknown";
    delivery_pending: "delivery_pending";
    delivery_failed: "delivery_failed";
    stopped: "stopped";
}>;
export declare const OccurrenceOutcomeDispositionSchema: z.ZodEnum<{
    failed: "failed";
    stopped: "stopped";
    deferred: "deferred";
    silent: "silent";
    offer: "offer";
    delivered: "delivered";
    uncertain: "uncertain";
}>;
export declare const NativeOccurrenceExecutionSchema: z.ZodObject<{
    jobId: z.ZodString;
    executionId: z.ZodString;
}, z.core.$strict>;
export declare const OccurrenceOutcomeReceiptSchema: z.ZodObject<{
    profile: z.ZodLiteral<"atum.occurrence-outcome/1">;
    stage: z.ZodEnum<{
        policy: "policy";
        script: "script";
        preflight: "preflight";
        model: "model";
        delivery: "delivery";
    }>;
    code: z.ZodEnum<{
        completed: "completed";
        legacy_unclassified: "legacy_unclassified";
        disabled: "disabled";
        not_due: "not_due";
        owner_active: "owner_active";
        pending_work: "pending_work";
        missing_time_zone: "missing_time_zone";
        audience_unavailable: "audience_unavailable";
        source_denied: "source_denied";
        source_unavailable: "source_unavailable";
        source_failed: "source_failed";
        no_change: "no_change";
        model_budget_exhausted: "model_budget_exhausted";
        compute_budget_exhausted: "compute_budget_exhausted";
        unfunded: "unfunded";
        lease_lost: "lease_lost";
        definition_stale: "definition_stale";
        tools_policy_mismatch: "tools_policy_mismatch";
        script_failed: "script_failed";
        script_timeout: "script_timeout";
        preflight_failed: "preflight_failed";
        model_failed: "model_failed";
        result_invalid: "result_invalid";
        submission_unknown: "submission_unknown";
        delivery_pending: "delivery_pending";
        delivery_failed: "delivery_failed";
        stopped: "stopped";
    }>;
    retryable: z.ZodBoolean;
    disposition: z.ZodEnum<{
        failed: "failed";
        stopped: "stopped";
        deferred: "deferred";
        silent: "silent";
        offer: "offer";
        delivered: "delivered";
        uncertain: "uncertain";
    }>;
    native: z.ZodNullable<z.ZodObject<{
        jobId: z.ZodString;
        executionId: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type OccurrenceOutcomeStage = z.infer<typeof OccurrenceOutcomeStageSchema>;
export type OccurrenceOutcomeCode = z.infer<typeof OccurrenceOutcomeCodeSchema>;
export type OccurrenceOutcomeDisposition = z.infer<typeof OccurrenceOutcomeDispositionSchema>;
export type NativeOccurrenceExecution = z.infer<typeof NativeOccurrenceExecutionSchema>;
export type OccurrenceOutcomeReceipt = z.infer<typeof OccurrenceOutcomeReceiptSchema>;
export interface LegacyOccurrenceRecord {
    state?: string;
    outcome?: string | null;
    deliveryDisposition?: string | null;
    skipReason?: string | null;
}
/**
 * Decode a persisted receipt without rewriting historical rows. New typed bytes
 * win. Terminal legacy rows receive one conservative compatibility projection;
 * live rows remain `null` because no outcome has happened yet.
 */
export declare function decodeOccurrenceOutcome(typed: unknown, legacy: LegacyOccurrenceRecord): OccurrenceOutcomeReceipt | null;
//# sourceMappingURL=occurrence-outcome.d.ts.map