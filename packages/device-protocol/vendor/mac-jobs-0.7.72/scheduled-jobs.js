import { z } from "zod";
export const CONTROLLER_JOBS_PROFILE = "atum.controller-jobs/1";
export const CONTROLLER_JOBS_V2_PROFILE = "atum.controller-jobs/2";
export const CONTROLLER_JOB_RESOLVE_PROFILE = "atum.controller-job-resolve/1";
export const CONTROLLER_JOB_DEFINITION_PROFILE = "atum.controller-job-definition/1";
export const CONTROLLER_JOB_RECONCILE_PROFILE = "atum.controller-job-reconcile/1";
export const CONTROLLER_JOB_FIRE_PROFILE = "atum.controller-job-fire/1";
export const MANAGED_JOB_EXTENSION_PROFILE = "atum.managed-job-extension/1";
const uuid = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const jobId = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const instant = z.iso.datetime({ offset: true });
const nullableText = (maximum) => z.string().min(1).max(maximum).nullable();
const safeRevision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const safeGeneration = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const HermesCronScheduleSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("once"),
        run_at: instant,
        display: z.string().min(1).max(160),
    }).strict(),
    z.object({
        kind: z.literal("interval"),
        minutes: z.number().int().min(1).max(525_600),
        display: z.string().min(1).max(160),
    }).strict(),
    z.object({
        kind: z.literal("cron"),
        expr: z.string().min(9).max(160),
        display: z.string().min(1).max(160),
    }).strict(),
]);
export const RoutineScheduleProjectionSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("once"), runAt: instant }).strict(),
    z.object({
        kind: z.literal("daily"),
        hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59),
    }).strict(),
    z.object({
        kind: z.literal("weekly"),
        hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59),
        weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    }).strict().superRefine((value, context) => {
        if (new Set(value.weekdays).size !== value.weekdays.length) {
            context.addIssue({ code: "custom", path: ["weekdays"], message: "weekdays must be unique" });
        }
    }),
    z.object({
        kind: z.literal("monthly"),
        day: z.number().int().min(1).max(28),
        hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59),
    }).strict(),
]);
const HermesManagedOriginSchema = z.object({
    platform: z.literal("atum"),
    kind: z.literal("managed_job"),
    job_id: jobId,
}).strict();
/**
 * The definition-bearing fields accepted by Hermes v0.22.5 `cron/jobs.py`.
 * Mutable scheduler state lives in `ControllerJobRuntimeSchema`; keeping it
 * separate makes a definition revision immutable and resolvable after claim.
 */
export const HermesCronJobDefinitionSchema = z.object({
    id: jobId,
    name: z.string().min(1).max(120),
    prompt: z.string().min(1).max(20_000),
    skills: z.array(z.string().min(1).max(128)).max(32),
    skill: z.string().min(1).max(128).nullable(),
    model: nullableText(256),
    provider: nullableText(128),
    base_url: z.url().max(4_096).nullable(),
    script: nullableText(65_536),
    no_agent: z.boolean(),
    monitor_script: nullableText(65_536),
    monitor_url: z.url().max(4_096).nullable(),
    context_from: z.array(jobId).max(32).nullable(),
    schedule: HermesCronScheduleSchema,
    schedule_display: z.string().min(1).max(160),
    repeat: z.object({
        times: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
        completed: z.literal(0),
    }).strict(),
    deliver: z.literal("origin"),
    origin: HermesManagedOriginSchema,
    enabled_toolsets: z.array(z.string().min(1).max(128)).max(64).nullable(),
    workdir: nullableText(4_096),
    attach_to_session: z.literal(false),
    reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).nullable(),
    failure_deliver: nullableText(4_096),
    interpreter: nullableText(4_096),
}).strict().superRefine((value, context) => {
    const first = value.skills[0] ?? null;
    if (value.skill !== first) {
        context.addIssue({ code: "custom", path: ["skill"], message: "skill must equal the first skills entry" });
    }
    if (value.no_agent && value.script === null) {
        context.addIssue({ code: "custom", path: ["script"], message: "no_agent requires script" });
    }
    if (value.monitor_script !== null && value.monitor_url !== null) {
        context.addIssue({ code: "custom", path: ["monitor_url"], message: "monitor sources are exclusive" });
    }
});
export const RoutineManagedJobExtensionSchema = z.object({
    profile: z.literal(MANAGED_JOB_EXTENSION_PROFILE),
    source: z.object({
        kind: z.literal("routine"),
        routineId: uuid,
    }).strict(),
    creator: z.object({
        kind: z.enum(["user", "system", "import"]),
        templateKey: z.string().min(1).max(32).nullable(),
        originalHomeJobId: jobId.nullable(),
    }).strict(),
    routine: z.object({
        schedule: RoutineScheduleProjectionSchema,
        timezone: z.string().min(1).max(64),
        notifications: z.boolean(),
    }).strict(),
    execution: z.object({
        class: z.literal("agent_turn"),
        budgetClass: z.literal("scheduled_occurrence"),
        audiencePolicyRef: z.literal("agent-room/current"),
        sourcePolicyRef: z.literal("agent-runtime/current"),
    }).strict(),
}).strict();
const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const SweepManagedJobExtensionSchema = z.object({
    profile: z.literal("atum.managed-sweep-extension/1"),
    source: z.object({ kind: z.literal("sweep"), agentPrincipal: uuid,
        occurrenceScheduleId: z.literal("sys_followup_sweep_v1") }).strict(),
    sweep: z.object({
        settingsRevision: safeRevision, policyVersion: z.literal(2), policyDigest: digest,
        occurrenceDefinitionDigest: digest, intervalMs: z.literal(7_200_000), quietMs: z.literal(600_000),
        normalStartHour: z.literal(8), normalEndHour: z.literal(21),
        warmupOffsetsMs: z.tuple([z.literal(300_000), z.literal(900_000), z.literal(2_100_000), z.literal(3_600_000)]),
        warmupAnchorAt: epochMs.nullable(), warmupNextIndex: z.number().int().min(1).max(5).nullable(),
        nextDueAt: epochMs, warmupNextDueAt: epochMs.nullable(),
    }).strict().superRefine((v, ctx) => {
        const valid = v.warmupAnchorAt === null
            ? v.warmupNextIndex === null && v.warmupNextDueAt === null
            : v.warmupNextIndex !== null && (v.warmupNextIndex === 5 ? v.warmupNextDueAt === null : v.warmupNextDueAt !== null);
        if (!valid)
            ctx.addIssue({ code: "custom", message: "inconsistent warm-up state" });
    }),
    execution: z.object({ class: z.literal("sweep"), budgetClass: z.literal("sweep"),
        admission: z.literal("agent-sweep"), requestId: z.literal("armId"),
        executionProfile: z.literal("atum.native-sweep/1") }).strict(),
}).strict();
export const ManagedJobExtensionSchema = z.union([RoutineManagedJobExtensionSchema, SweepManagedJobExtensionSchema]);
export const ControllerJobRuntimeSchema = z.object({
    enabled: z.boolean(),
    state: z.enum(["scheduled", "paused", "completed"]),
    scheduledNextRunAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    manualRunAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    nextOccurrenceAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    nextTrigger: z.enum(["scheduled", "manual"]).nullable(),
}).strict().superRefine((value, context) => {
    const candidates = [value.scheduledNextRunAt, value.manualRunAt].filter((item) => item !== null);
    const expectedNext = candidates.length > 0 ? Math.min(...candidates) : null;
    if (value.nextOccurrenceAt !== expectedNext) {
        context.addIssue({ code: "custom", path: ["nextOccurrenceAt"], message: "next occurrence must be the earliest trigger" });
    }
    const expectedTrigger = expectedNext === null ? null
        : value.manualRunAt !== null && value.manualRunAt === expectedNext ? "manual" : "scheduled";
    if (value.nextTrigger !== expectedTrigger) {
        context.addIssue({ code: "custom", path: ["nextTrigger"], message: "next trigger must identify the earliest occurrence" });
    }
    if (value.state === "scheduled" && !value.enabled) {
        context.addIssue({ code: "custom", path: ["state"], message: "scheduled jobs are enabled" });
    }
});
export const ControllerJobDefinitionSchema = z.object({
    jobId,
    definitionRevision: safeRevision,
    definitionDigest: digest,
    nativeDefinition: HermesCronJobDefinitionSchema,
    atumExtension: ManagedJobExtensionSchema,
}).strict().superRefine((value, context) => {
    if (value.nativeDefinition.id !== value.jobId) {
        context.addIssue({ code: "custom", path: ["nativeDefinition", "id"], message: "native definition id must equal jobId" });
    }
    if (value.nativeDefinition.origin.job_id !== value.jobId) {
        context.addIssue({ code: "custom", path: ["nativeDefinition", "origin", "job_id"], message: "origin job id must equal jobId" });
    }
});
export const ControllerJobSchema = ControllerJobDefinitionSchema.safeExtend({
    executionGeneration: z.literal(0),
    clockState: z.literal("projection_only"),
    runtime: ControllerJobRuntimeSchema,
}).strict();
export const ControllerJobArmSchema = z.object({
    armId: uuid,
    executionGeneration: safeGeneration,
    occurrenceAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    nextTrigger: z.enum(["scheduled", "manual"]),
    catchupWindowMs: z.number().int().min(120_000).max(7_200_000),
    state: z.enum(["armed", "claimed"]),
    claimExpiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict();
export const ManagedControllerJobSchema = ControllerJobDefinitionSchema.safeExtend({
    executionGeneration: safeGeneration,
    clockState: z.literal("external"),
    runtime: ControllerJobRuntimeSchema,
    arm: ControllerJobArmSchema.nullable(),
}).strict().superRefine((value, context) => {
    if (value.arm !== null && value.arm.executionGeneration !== value.executionGeneration) {
        context.addIssue({ code: "custom", path: ["arm", "executionGeneration"], message: "arm generation must equal job generation" });
    }
});
export const ControllerJobsSnapshotSchema = z.object({
    profile: z.literal(CONTROLLER_JOBS_PROFILE),
    agentPrincipal: uuid,
    legacyState: z.enum(["unknown", "clear", "present"]),
    jobs: z.array(ControllerJobSchema).max(64),
}).strict().superRefine((value, context) => {
    const ids = value.jobs.map((job) => job.jobId);
    if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", path: ["jobs"], message: "job ids must be unique" });
    }
});
export const ControllerJobsV2SnapshotSchema = z.object({
    profile: z.literal(CONTROLLER_JOBS_V2_PROFILE),
    agentPrincipal: uuid,
    legacyState: z.enum(["unknown", "clear", "present"]),
    jobs: z.array(ManagedControllerJobSchema).max(65),
}).strict().superRefine((value, context) => {
    const sweeps = value.jobs.filter((job) => job.atumExtension.source.kind === "sweep");
    if (sweeps.length > 1 || value.jobs.length - sweeps.length > 64) {
        context.addIssue({ code: "custom", path: ["jobs"], message: "at most 64 routines and one sweep" });
    }
    for (const job of sweeps) {
        const source = job.atumExtension.source;
        if (source.kind === "sweep" && (source.agentPrincipal !== value.agentPrincipal
            || job.jobId !== `as_${value.agentPrincipal.replaceAll("-", "")}`)) {
            context.addIssue({ code: "custom", path: ["jobs"], message: "sweep must belong to the snapshot agent" });
        }
    }
    const ids = value.jobs.map((job) => job.jobId);
    if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", path: ["jobs"], message: "job ids must be unique" });
    }
});
export const ControllerJobReconcileRequestSchema = z.object({
    profile: z.enum([CONTROLLER_JOB_RECONCILE_PROFILE, "atum.controller-job-reconcile/2"]),
    operation: z.literal("reconcile"),
    leaseToken: uuid,
}).strict();
export const ControllerJobFireRequestSchema = z.union([
    z.object({
        profile: z.literal(CONTROLLER_JOB_FIRE_PROFILE),
        operation: z.literal("claim"),
        leaseToken: uuid,
    }).strict(),
    z.object({
        profile: z.literal(CONTROLLER_JOB_FIRE_PROFILE),
        operation: z.literal("complete"),
        leaseToken: uuid,
        armId: uuid,
        occurrenceId: uuid,
        outcome: z.enum(["queued", "missed", "terminal"]),
    }).strict(),
    z.object({
        profile: z.literal(CONTROLLER_JOB_FIRE_PROFILE),
        operation: z.literal("complete"),
        leaseToken: uuid,
        armId: uuid,
        occurrenceId: z.null(),
        outcome: z.literal("daily_cap"),
    }).strict(),
]);
export const ControllerJobFireClaimSchema = ControllerJobDefinitionSchema.safeExtend({
    arm: ControllerJobArmSchema.extend({ state: z.literal("claimed") }).strict(),
}).strict().superRefine((value, context) => {
    if (value.arm.executionGeneration < 1) {
        context.addIssue({ code: "custom", path: ["arm", "executionGeneration"], message: "managed fire requires a nonzero generation" });
    }
});
export const ControllerJobFireResponseSchema = z.discriminatedUnion("operation", [
    z.object({
        profile: z.literal(CONTROLLER_JOB_FIRE_PROFILE),
        operation: z.literal("claimed"),
        agentPrincipal: uuid,
        fire: ControllerJobFireClaimSchema.nullable(),
    }).strict(),
    z.object({
        profile: z.literal(CONTROLLER_JOB_FIRE_PROFILE),
        operation: z.literal("completed"),
        agentPrincipal: uuid,
        armId: uuid,
        occurrenceId: uuid.nullable(),
        outcome: z.enum(["queued", "missed", "daily_cap", "terminal"]),
    }).strict(),
]);
export const ControllerJobResolveRequestSchema = z.object({
    profile: z.literal(CONTROLLER_JOB_RESOLVE_PROFILE),
    jobId,
    definitionRevision: safeRevision,
    definitionDigest: digest,
}).strict();
export const ControllerJobDefinitionResponseSchema = ControllerJobDefinitionSchema.safeExtend({
    profile: z.literal(CONTROLLER_JOB_DEFINITION_PROFILE),
    agentPrincipal: uuid,
}).strict();
