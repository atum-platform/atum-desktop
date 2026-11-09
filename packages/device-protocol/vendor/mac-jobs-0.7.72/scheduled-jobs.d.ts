import { z } from "zod";
export declare const CONTROLLER_JOBS_PROFILE: "atum.controller-jobs/1";
export declare const CONTROLLER_JOBS_V2_PROFILE: "atum.controller-jobs/2";
export declare const CONTROLLER_JOB_RESOLVE_PROFILE: "atum.controller-job-resolve/1";
export declare const CONTROLLER_JOB_DEFINITION_PROFILE: "atum.controller-job-definition/1";
export declare const CONTROLLER_JOB_RECONCILE_PROFILE: "atum.controller-job-reconcile/1";
export declare const CONTROLLER_JOB_FIRE_PROFILE: "atum.controller-job-fire/1";
export declare const MANAGED_JOB_EXTENSION_PROFILE: "atum.managed-job-extension/1";
export declare const HermesCronScheduleSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"once">;
    run_at: z.ZodISODateTime;
    display: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"interval">;
    minutes: z.ZodNumber;
    display: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"cron">;
    expr: z.ZodString;
    display: z.ZodString;
}, z.core.$strict>], "kind">;
export declare const RoutineScheduleProjectionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"once">;
    runAt: z.ZodISODateTime;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"daily">;
    hour: z.ZodNumber;
    minute: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"weekly">;
    hour: z.ZodNumber;
    minute: z.ZodNumber;
    weekdays: z.ZodArray<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"monthly">;
    day: z.ZodNumber;
    hour: z.ZodNumber;
    minute: z.ZodNumber;
}, z.core.$strict>], "kind">;
/**
 * The definition-bearing fields accepted by Hermes v0.22.5 `cron/jobs.py`.
 * Mutable scheduler state lives in `ControllerJobRuntimeSchema`; keeping it
 * separate makes a definition revision immutable and resolvable after claim.
 */
export declare const HermesCronJobDefinitionSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    prompt: z.ZodString;
    skills: z.ZodArray<z.ZodString>;
    skill: z.ZodNullable<z.ZodString>;
    model: z.ZodNullable<z.ZodString>;
    provider: z.ZodNullable<z.ZodString>;
    base_url: z.ZodNullable<z.ZodURL>;
    script: z.ZodNullable<z.ZodString>;
    no_agent: z.ZodBoolean;
    monitor_script: z.ZodNullable<z.ZodString>;
    monitor_url: z.ZodNullable<z.ZodURL>;
    context_from: z.ZodNullable<z.ZodArray<z.ZodString>>;
    schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"once">;
        run_at: z.ZodISODateTime;
        display: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"interval">;
        minutes: z.ZodNumber;
        display: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"cron">;
        expr: z.ZodString;
        display: z.ZodString;
    }, z.core.$strict>], "kind">;
    schedule_display: z.ZodString;
    repeat: z.ZodObject<{
        times: z.ZodNullable<z.ZodNumber>;
        completed: z.ZodLiteral<0>;
    }, z.core.$strict>;
    deliver: z.ZodLiteral<"origin">;
    origin: z.ZodObject<{
        platform: z.ZodLiteral<"atum">;
        kind: z.ZodLiteral<"managed_job">;
        job_id: z.ZodString;
    }, z.core.$strict>;
    enabled_toolsets: z.ZodNullable<z.ZodArray<z.ZodString>>;
    workdir: z.ZodNullable<z.ZodString>;
    attach_to_session: z.ZodLiteral<false>;
    reasoning_effort: z.ZodNullable<z.ZodEnum<{
        none: "none";
        low: "low";
        medium: "medium";
        high: "high";
        max: "max";
        minimal: "minimal";
        xhigh: "xhigh";
        ultra: "ultra";
    }>>;
    failure_deliver: z.ZodNullable<z.ZodString>;
    interpreter: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const RoutineManagedJobExtensionSchema: z.ZodObject<{
    profile: z.ZodLiteral<"atum.managed-job-extension/1">;
    source: z.ZodObject<{
        kind: z.ZodLiteral<"routine">;
        routineId: z.ZodString;
    }, z.core.$strict>;
    creator: z.ZodObject<{
        kind: z.ZodEnum<{
            user: "user";
            import: "import";
            system: "system";
        }>;
        templateKey: z.ZodNullable<z.ZodString>;
        originalHomeJobId: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    routine: z.ZodObject<{
        schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"once">;
            runAt: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"daily">;
            hour: z.ZodNumber;
            minute: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"weekly">;
            hour: z.ZodNumber;
            minute: z.ZodNumber;
            weekdays: z.ZodArray<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"monthly">;
            day: z.ZodNumber;
            hour: z.ZodNumber;
            minute: z.ZodNumber;
        }, z.core.$strict>], "kind">;
        timezone: z.ZodString;
        notifications: z.ZodBoolean;
    }, z.core.$strict>;
    execution: z.ZodObject<{
        class: z.ZodLiteral<"agent_turn">;
        budgetClass: z.ZodLiteral<"scheduled_occurrence">;
        audiencePolicyRef: z.ZodLiteral<"agent-room/current">;
        sourcePolicyRef: z.ZodLiteral<"agent-runtime/current">;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const SweepManagedJobExtensionSchema: z.ZodObject<{
    profile: z.ZodLiteral<"atum.managed-sweep-extension/1">;
    source: z.ZodObject<{
        kind: z.ZodLiteral<"sweep">;
        agentPrincipal: z.ZodString;
        occurrenceScheduleId: z.ZodLiteral<"sys_followup_sweep_v1">;
    }, z.core.$strict>;
    sweep: z.ZodObject<{
        settingsRevision: z.ZodNumber;
        policyVersion: z.ZodLiteral<2>;
        policyDigest: z.ZodString;
        occurrenceDefinitionDigest: z.ZodString;
        intervalMs: z.ZodLiteral<7200000>;
        quietMs: z.ZodLiteral<600000>;
        normalStartHour: z.ZodLiteral<8>;
        normalEndHour: z.ZodLiteral<21>;
        warmupOffsetsMs: z.ZodTuple<[z.ZodLiteral<300000>, z.ZodLiteral<900000>, z.ZodLiteral<2100000>, z.ZodLiteral<3600000>], null>;
        warmupAnchorAt: z.ZodNullable<z.ZodNumber>;
        warmupNextIndex: z.ZodNullable<z.ZodNumber>;
        nextDueAt: z.ZodNumber;
        warmupNextDueAt: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    execution: z.ZodObject<{
        class: z.ZodLiteral<"sweep">;
        budgetClass: z.ZodLiteral<"sweep">;
        admission: z.ZodLiteral<"agent-sweep">;
        requestId: z.ZodLiteral<"armId">;
        executionProfile: z.ZodLiteral<"atum.native-sweep/1">;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const ManagedJobExtensionSchema: z.ZodUnion<readonly [z.ZodObject<{
    profile: z.ZodLiteral<"atum.managed-job-extension/1">;
    source: z.ZodObject<{
        kind: z.ZodLiteral<"routine">;
        routineId: z.ZodString;
    }, z.core.$strict>;
    creator: z.ZodObject<{
        kind: z.ZodEnum<{
            user: "user";
            import: "import";
            system: "system";
        }>;
        templateKey: z.ZodNullable<z.ZodString>;
        originalHomeJobId: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    routine: z.ZodObject<{
        schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"once">;
            runAt: z.ZodISODateTime;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"daily">;
            hour: z.ZodNumber;
            minute: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"weekly">;
            hour: z.ZodNumber;
            minute: z.ZodNumber;
            weekdays: z.ZodArray<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"monthly">;
            day: z.ZodNumber;
            hour: z.ZodNumber;
            minute: z.ZodNumber;
        }, z.core.$strict>], "kind">;
        timezone: z.ZodString;
        notifications: z.ZodBoolean;
    }, z.core.$strict>;
    execution: z.ZodObject<{
        class: z.ZodLiteral<"agent_turn">;
        budgetClass: z.ZodLiteral<"scheduled_occurrence">;
        audiencePolicyRef: z.ZodLiteral<"agent-room/current">;
        sourcePolicyRef: z.ZodLiteral<"agent-runtime/current">;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    profile: z.ZodLiteral<"atum.managed-sweep-extension/1">;
    source: z.ZodObject<{
        kind: z.ZodLiteral<"sweep">;
        agentPrincipal: z.ZodString;
        occurrenceScheduleId: z.ZodLiteral<"sys_followup_sweep_v1">;
    }, z.core.$strict>;
    sweep: z.ZodObject<{
        settingsRevision: z.ZodNumber;
        policyVersion: z.ZodLiteral<2>;
        policyDigest: z.ZodString;
        occurrenceDefinitionDigest: z.ZodString;
        intervalMs: z.ZodLiteral<7200000>;
        quietMs: z.ZodLiteral<600000>;
        normalStartHour: z.ZodLiteral<8>;
        normalEndHour: z.ZodLiteral<21>;
        warmupOffsetsMs: z.ZodTuple<[z.ZodLiteral<300000>, z.ZodLiteral<900000>, z.ZodLiteral<2100000>, z.ZodLiteral<3600000>], null>;
        warmupAnchorAt: z.ZodNullable<z.ZodNumber>;
        warmupNextIndex: z.ZodNullable<z.ZodNumber>;
        nextDueAt: z.ZodNumber;
        warmupNextDueAt: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    execution: z.ZodObject<{
        class: z.ZodLiteral<"sweep">;
        budgetClass: z.ZodLiteral<"sweep">;
        admission: z.ZodLiteral<"agent-sweep">;
        requestId: z.ZodLiteral<"armId">;
        executionProfile: z.ZodLiteral<"atum.native-sweep/1">;
    }, z.core.$strict>;
}, z.core.$strict>]>;
export declare const ControllerJobRuntimeSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    state: z.ZodEnum<{
        completed: "completed";
        paused: "paused";
        scheduled: "scheduled";
    }>;
    scheduledNextRunAt: z.ZodNullable<z.ZodNumber>;
    manualRunAt: z.ZodNullable<z.ZodNumber>;
    nextOccurrenceAt: z.ZodNullable<z.ZodNumber>;
    nextTrigger: z.ZodNullable<z.ZodEnum<{
        manual: "manual";
        scheduled: "scheduled";
    }>>;
}, z.core.$strict>;
export declare const ControllerJobDefinitionSchema: z.ZodObject<{
    jobId: z.ZodString;
    definitionRevision: z.ZodNumber;
    definitionDigest: z.ZodString;
    nativeDefinition: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        prompt: z.ZodString;
        skills: z.ZodArray<z.ZodString>;
        skill: z.ZodNullable<z.ZodString>;
        model: z.ZodNullable<z.ZodString>;
        provider: z.ZodNullable<z.ZodString>;
        base_url: z.ZodNullable<z.ZodURL>;
        script: z.ZodNullable<z.ZodString>;
        no_agent: z.ZodBoolean;
        monitor_script: z.ZodNullable<z.ZodString>;
        monitor_url: z.ZodNullable<z.ZodURL>;
        context_from: z.ZodNullable<z.ZodArray<z.ZodString>>;
        schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"once">;
            run_at: z.ZodISODateTime;
            display: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"interval">;
            minutes: z.ZodNumber;
            display: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"cron">;
            expr: z.ZodString;
            display: z.ZodString;
        }, z.core.$strict>], "kind">;
        schedule_display: z.ZodString;
        repeat: z.ZodObject<{
            times: z.ZodNullable<z.ZodNumber>;
            completed: z.ZodLiteral<0>;
        }, z.core.$strict>;
        deliver: z.ZodLiteral<"origin">;
        origin: z.ZodObject<{
            platform: z.ZodLiteral<"atum">;
            kind: z.ZodLiteral<"managed_job">;
            job_id: z.ZodString;
        }, z.core.$strict>;
        enabled_toolsets: z.ZodNullable<z.ZodArray<z.ZodString>>;
        workdir: z.ZodNullable<z.ZodString>;
        attach_to_session: z.ZodLiteral<false>;
        reasoning_effort: z.ZodNullable<z.ZodEnum<{
            none: "none";
            low: "low";
            medium: "medium";
            high: "high";
            max: "max";
            minimal: "minimal";
            xhigh: "xhigh";
            ultra: "ultra";
        }>>;
        failure_deliver: z.ZodNullable<z.ZodString>;
        interpreter: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    atumExtension: z.ZodUnion<readonly [z.ZodObject<{
        profile: z.ZodLiteral<"atum.managed-job-extension/1">;
        source: z.ZodObject<{
            kind: z.ZodLiteral<"routine">;
            routineId: z.ZodString;
        }, z.core.$strict>;
        creator: z.ZodObject<{
            kind: z.ZodEnum<{
                user: "user";
                import: "import";
                system: "system";
            }>;
            templateKey: z.ZodNullable<z.ZodString>;
            originalHomeJobId: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        routine: z.ZodObject<{
            schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"once">;
                runAt: z.ZodISODateTime;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"daily">;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"weekly">;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
                weekdays: z.ZodArray<z.ZodNumber>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"monthly">;
                day: z.ZodNumber;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
            }, z.core.$strict>], "kind">;
            timezone: z.ZodString;
            notifications: z.ZodBoolean;
        }, z.core.$strict>;
        execution: z.ZodObject<{
            class: z.ZodLiteral<"agent_turn">;
            budgetClass: z.ZodLiteral<"scheduled_occurrence">;
            audiencePolicyRef: z.ZodLiteral<"agent-room/current">;
            sourcePolicyRef: z.ZodLiteral<"agent-runtime/current">;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        profile: z.ZodLiteral<"atum.managed-sweep-extension/1">;
        source: z.ZodObject<{
            kind: z.ZodLiteral<"sweep">;
            agentPrincipal: z.ZodString;
            occurrenceScheduleId: z.ZodLiteral<"sys_followup_sweep_v1">;
        }, z.core.$strict>;
        sweep: z.ZodObject<{
            settingsRevision: z.ZodNumber;
            policyVersion: z.ZodLiteral<2>;
            policyDigest: z.ZodString;
            occurrenceDefinitionDigest: z.ZodString;
            intervalMs: z.ZodLiteral<7200000>;
            quietMs: z.ZodLiteral<600000>;
            normalStartHour: z.ZodLiteral<8>;
            normalEndHour: z.ZodLiteral<21>;
            warmupOffsetsMs: z.ZodTuple<[z.ZodLiteral<300000>, z.ZodLiteral<900000>, z.ZodLiteral<2100000>, z.ZodLiteral<3600000>], null>;
            warmupAnchorAt: z.ZodNullable<z.ZodNumber>;
            warmupNextIndex: z.ZodNullable<z.ZodNumber>;
            nextDueAt: z.ZodNumber;
            warmupNextDueAt: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        execution: z.ZodObject<{
            class: z.ZodLiteral<"sweep">;
            budgetClass: z.ZodLiteral<"sweep">;
            admission: z.ZodLiteral<"agent-sweep">;
            requestId: z.ZodLiteral<"armId">;
            executionProfile: z.ZodLiteral<"atum.native-sweep/1">;
        }, z.core.$strict>;
    }, z.core.$strict>]>;
}, z.core.$strict>;
export declare const ControllerJobSchema: z.ZodObject<{
    jobId: z.ZodString;
    definitionRevision: z.ZodNumber;
    definitionDigest: z.ZodString;
    nativeDefinition: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        prompt: z.ZodString;
        skills: z.ZodArray<z.ZodString>;
        skill: z.ZodNullable<z.ZodString>;
        model: z.ZodNullable<z.ZodString>;
        provider: z.ZodNullable<z.ZodString>;
        base_url: z.ZodNullable<z.ZodURL>;
        script: z.ZodNullable<z.ZodString>;
        no_agent: z.ZodBoolean;
        monitor_script: z.ZodNullable<z.ZodString>;
        monitor_url: z.ZodNullable<z.ZodURL>;
        context_from: z.ZodNullable<z.ZodArray<z.ZodString>>;
        schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"once">;
            run_at: z.ZodISODateTime;
            display: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"interval">;
            minutes: z.ZodNumber;
            display: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"cron">;
            expr: z.ZodString;
            display: z.ZodString;
        }, z.core.$strict>], "kind">;
        schedule_display: z.ZodString;
        repeat: z.ZodObject<{
            times: z.ZodNullable<z.ZodNumber>;
            completed: z.ZodLiteral<0>;
        }, z.core.$strict>;
        deliver: z.ZodLiteral<"origin">;
        origin: z.ZodObject<{
            platform: z.ZodLiteral<"atum">;
            kind: z.ZodLiteral<"managed_job">;
            job_id: z.ZodString;
        }, z.core.$strict>;
        enabled_toolsets: z.ZodNullable<z.ZodArray<z.ZodString>>;
        workdir: z.ZodNullable<z.ZodString>;
        attach_to_session: z.ZodLiteral<false>;
        reasoning_effort: z.ZodNullable<z.ZodEnum<{
            none: "none";
            low: "low";
            medium: "medium";
            high: "high";
            max: "max";
            minimal: "minimal";
            xhigh: "xhigh";
            ultra: "ultra";
        }>>;
        failure_deliver: z.ZodNullable<z.ZodString>;
        interpreter: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    atumExtension: z.ZodUnion<readonly [z.ZodObject<{
        profile: z.ZodLiteral<"atum.managed-job-extension/1">;
        source: z.ZodObject<{
            kind: z.ZodLiteral<"routine">;
            routineId: z.ZodString;
        }, z.core.$strict>;
        creator: z.ZodObject<{
            kind: z.ZodEnum<{
                user: "user";
                import: "import";
                system: "system";
            }>;
            templateKey: z.ZodNullable<z.ZodString>;
            originalHomeJobId: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        routine: z.ZodObject<{
            schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"once">;
                runAt: z.ZodISODateTime;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"daily">;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"weekly">;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
                weekdays: z.ZodArray<z.ZodNumber>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"monthly">;
                day: z.ZodNumber;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
            }, z.core.$strict>], "kind">;
            timezone: z.ZodString;
            notifications: z.ZodBoolean;
        }, z.core.$strict>;
        execution: z.ZodObject<{
            class: z.ZodLiteral<"agent_turn">;
            budgetClass: z.ZodLiteral<"scheduled_occurrence">;
            audiencePolicyRef: z.ZodLiteral<"agent-room/current">;
            sourcePolicyRef: z.ZodLiteral<"agent-runtime/current">;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        profile: z.ZodLiteral<"atum.managed-sweep-extension/1">;
        source: z.ZodObject<{
            kind: z.ZodLiteral<"sweep">;
            agentPrincipal: z.ZodString;
            occurrenceScheduleId: z.ZodLiteral<"sys_followup_sweep_v1">;
        }, z.core.$strict>;
        sweep: z.ZodObject<{
            settingsRevision: z.ZodNumber;
            policyVersion: z.ZodLiteral<2>;
            policyDigest: z.ZodString;
            occurrenceDefinitionDigest: z.ZodString;
            intervalMs: z.ZodLiteral<7200000>;
            quietMs: z.ZodLiteral<600000>;
            normalStartHour: z.ZodLiteral<8>;
            normalEndHour: z.ZodLiteral<21>;
            warmupOffsetsMs: z.ZodTuple<[z.ZodLiteral<300000>, z.ZodLiteral<900000>, z.ZodLiteral<2100000>, z.ZodLiteral<3600000>], null>;
            warmupAnchorAt: z.ZodNullable<z.ZodNumber>;
            warmupNextIndex: z.ZodNullable<z.ZodNumber>;
            nextDueAt: z.ZodNumber;
            warmupNextDueAt: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        execution: z.ZodObject<{
            class: z.ZodLiteral<"sweep">;
            budgetClass: z.ZodLiteral<"sweep">;
            admission: z.ZodLiteral<"agent-sweep">;
            requestId: z.ZodLiteral<"armId">;
            executionProfile: z.ZodLiteral<"atum.native-sweep/1">;
        }, z.core.$strict>;
    }, z.core.$strict>]>;
    executionGeneration: z.ZodLiteral<0>;
    clockState: z.ZodLiteral<"projection_only">;
    runtime: z.ZodObject<{
        enabled: z.ZodBoolean;
        state: z.ZodEnum<{
            completed: "completed";
            paused: "paused";
            scheduled: "scheduled";
        }>;
        scheduledNextRunAt: z.ZodNullable<z.ZodNumber>;
        manualRunAt: z.ZodNullable<z.ZodNumber>;
        nextOccurrenceAt: z.ZodNullable<z.ZodNumber>;
        nextTrigger: z.ZodNullable<z.ZodEnum<{
            manual: "manual";
            scheduled: "scheduled";
        }>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const ControllerJobArmSchema: z.ZodObject<{
    armId: z.ZodString;
    executionGeneration: z.ZodNumber;
    occurrenceAt: z.ZodNumber;
    nextTrigger: z.ZodEnum<{
        manual: "manual";
        scheduled: "scheduled";
    }>;
    catchupWindowMs: z.ZodNumber;
    state: z.ZodEnum<{
        claimed: "claimed";
        armed: "armed";
    }>;
    claimExpiresAt: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export declare const ManagedControllerJobSchema: z.ZodObject<{
    jobId: z.ZodString;
    definitionRevision: z.ZodNumber;
    definitionDigest: z.ZodString;
    nativeDefinition: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        prompt: z.ZodString;
        skills: z.ZodArray<z.ZodString>;
        skill: z.ZodNullable<z.ZodString>;
        model: z.ZodNullable<z.ZodString>;
        provider: z.ZodNullable<z.ZodString>;
        base_url: z.ZodNullable<z.ZodURL>;
        script: z.ZodNullable<z.ZodString>;
        no_agent: z.ZodBoolean;
        monitor_script: z.ZodNullable<z.ZodString>;
        monitor_url: z.ZodNullable<z.ZodURL>;
        context_from: z.ZodNullable<z.ZodArray<z.ZodString>>;
        schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"once">;
            run_at: z.ZodISODateTime;
            display: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"interval">;
            minutes: z.ZodNumber;
            display: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"cron">;
            expr: z.ZodString;
            display: z.ZodString;
        }, z.core.$strict>], "kind">;
        schedule_display: z.ZodString;
        repeat: z.ZodObject<{
            times: z.ZodNullable<z.ZodNumber>;
            completed: z.ZodLiteral<0>;
        }, z.core.$strict>;
        deliver: z.ZodLiteral<"origin">;
        origin: z.ZodObject<{
            platform: z.ZodLiteral<"atum">;
            kind: z.ZodLiteral<"managed_job">;
            job_id: z.ZodString;
        }, z.core.$strict>;
        enabled_toolsets: z.ZodNullable<z.ZodArray<z.ZodString>>;
        workdir: z.ZodNullable<z.ZodString>;
        attach_to_session: z.ZodLiteral<false>;
        reasoning_effort: z.ZodNullable<z.ZodEnum<{
            none: "none";
            low: "low";
            medium: "medium";
            high: "high";
            max: "max";
            minimal: "minimal";
            xhigh: "xhigh";
            ultra: "ultra";
        }>>;
        failure_deliver: z.ZodNullable<z.ZodString>;
        interpreter: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    atumExtension: z.ZodUnion<readonly [z.ZodObject<{
        profile: z.ZodLiteral<"atum.managed-job-extension/1">;
        source: z.ZodObject<{
            kind: z.ZodLiteral<"routine">;
            routineId: z.ZodString;
        }, z.core.$strict>;
        creator: z.ZodObject<{
            kind: z.ZodEnum<{
                user: "user";
                import: "import";
                system: "system";
            }>;
            templateKey: z.ZodNullable<z.ZodString>;
            originalHomeJobId: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        routine: z.ZodObject<{
            schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"once">;
                runAt: z.ZodISODateTime;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"daily">;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"weekly">;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
                weekdays: z.ZodArray<z.ZodNumber>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"monthly">;
                day: z.ZodNumber;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
            }, z.core.$strict>], "kind">;
            timezone: z.ZodString;
            notifications: z.ZodBoolean;
        }, z.core.$strict>;
        execution: z.ZodObject<{
            class: z.ZodLiteral<"agent_turn">;
            budgetClass: z.ZodLiteral<"scheduled_occurrence">;
            audiencePolicyRef: z.ZodLiteral<"agent-room/current">;
            sourcePolicyRef: z.ZodLiteral<"agent-runtime/current">;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        profile: z.ZodLiteral<"atum.managed-sweep-extension/1">;
        source: z.ZodObject<{
            kind: z.ZodLiteral<"sweep">;
            agentPrincipal: z.ZodString;
            occurrenceScheduleId: z.ZodLiteral<"sys_followup_sweep_v1">;
        }, z.core.$strict>;
        sweep: z.ZodObject<{
            settingsRevision: z.ZodNumber;
            policyVersion: z.ZodLiteral<2>;
            policyDigest: z.ZodString;
            occurrenceDefinitionDigest: z.ZodString;
            intervalMs: z.ZodLiteral<7200000>;
            quietMs: z.ZodLiteral<600000>;
            normalStartHour: z.ZodLiteral<8>;
            normalEndHour: z.ZodLiteral<21>;
            warmupOffsetsMs: z.ZodTuple<[z.ZodLiteral<300000>, z.ZodLiteral<900000>, z.ZodLiteral<2100000>, z.ZodLiteral<3600000>], null>;
            warmupAnchorAt: z.ZodNullable<z.ZodNumber>;
            warmupNextIndex: z.ZodNullable<z.ZodNumber>;
            nextDueAt: z.ZodNumber;
            warmupNextDueAt: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        execution: z.ZodObject<{
            class: z.ZodLiteral<"sweep">;
            budgetClass: z.ZodLiteral<"sweep">;
            admission: z.ZodLiteral<"agent-sweep">;
            requestId: z.ZodLiteral<"armId">;
            executionProfile: z.ZodLiteral<"atum.native-sweep/1">;
        }, z.core.$strict>;
    }, z.core.$strict>]>;
    executionGeneration: z.ZodNumber;
    clockState: z.ZodLiteral<"external">;
    runtime: z.ZodObject<{
        enabled: z.ZodBoolean;
        state: z.ZodEnum<{
            completed: "completed";
            paused: "paused";
            scheduled: "scheduled";
        }>;
        scheduledNextRunAt: z.ZodNullable<z.ZodNumber>;
        manualRunAt: z.ZodNullable<z.ZodNumber>;
        nextOccurrenceAt: z.ZodNullable<z.ZodNumber>;
        nextTrigger: z.ZodNullable<z.ZodEnum<{
            manual: "manual";
            scheduled: "scheduled";
        }>>;
    }, z.core.$strict>;
    arm: z.ZodNullable<z.ZodObject<{
        armId: z.ZodString;
        executionGeneration: z.ZodNumber;
        occurrenceAt: z.ZodNumber;
        nextTrigger: z.ZodEnum<{
            manual: "manual";
            scheduled: "scheduled";
        }>;
        catchupWindowMs: z.ZodNumber;
        state: z.ZodEnum<{
            claimed: "claimed";
            armed: "armed";
        }>;
        claimExpiresAt: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const ControllerJobsSnapshotSchema: z.ZodObject<{
    profile: z.ZodLiteral<"atum.controller-jobs/1">;
    agentPrincipal: z.ZodString;
    legacyState: z.ZodEnum<{
        unknown: "unknown";
        clear: "clear";
        present: "present";
    }>;
    jobs: z.ZodArray<z.ZodObject<{
        jobId: z.ZodString;
        definitionRevision: z.ZodNumber;
        definitionDigest: z.ZodString;
        nativeDefinition: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            prompt: z.ZodString;
            skills: z.ZodArray<z.ZodString>;
            skill: z.ZodNullable<z.ZodString>;
            model: z.ZodNullable<z.ZodString>;
            provider: z.ZodNullable<z.ZodString>;
            base_url: z.ZodNullable<z.ZodURL>;
            script: z.ZodNullable<z.ZodString>;
            no_agent: z.ZodBoolean;
            monitor_script: z.ZodNullable<z.ZodString>;
            monitor_url: z.ZodNullable<z.ZodURL>;
            context_from: z.ZodNullable<z.ZodArray<z.ZodString>>;
            schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"once">;
                run_at: z.ZodISODateTime;
                display: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"interval">;
                minutes: z.ZodNumber;
                display: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"cron">;
                expr: z.ZodString;
                display: z.ZodString;
            }, z.core.$strict>], "kind">;
            schedule_display: z.ZodString;
            repeat: z.ZodObject<{
                times: z.ZodNullable<z.ZodNumber>;
                completed: z.ZodLiteral<0>;
            }, z.core.$strict>;
            deliver: z.ZodLiteral<"origin">;
            origin: z.ZodObject<{
                platform: z.ZodLiteral<"atum">;
                kind: z.ZodLiteral<"managed_job">;
                job_id: z.ZodString;
            }, z.core.$strict>;
            enabled_toolsets: z.ZodNullable<z.ZodArray<z.ZodString>>;
            workdir: z.ZodNullable<z.ZodString>;
            attach_to_session: z.ZodLiteral<false>;
            reasoning_effort: z.ZodNullable<z.ZodEnum<{
                none: "none";
                low: "low";
                medium: "medium";
                high: "high";
                max: "max";
                minimal: "minimal";
                xhigh: "xhigh";
                ultra: "ultra";
            }>>;
            failure_deliver: z.ZodNullable<z.ZodString>;
            interpreter: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        atumExtension: z.ZodUnion<readonly [z.ZodObject<{
            profile: z.ZodLiteral<"atum.managed-job-extension/1">;
            source: z.ZodObject<{
                kind: z.ZodLiteral<"routine">;
                routineId: z.ZodString;
            }, z.core.$strict>;
            creator: z.ZodObject<{
                kind: z.ZodEnum<{
                    user: "user";
                    import: "import";
                    system: "system";
                }>;
                templateKey: z.ZodNullable<z.ZodString>;
                originalHomeJobId: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            routine: z.ZodObject<{
                schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"once">;
                    runAt: z.ZodISODateTime;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"daily">;
                    hour: z.ZodNumber;
                    minute: z.ZodNumber;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"weekly">;
                    hour: z.ZodNumber;
                    minute: z.ZodNumber;
                    weekdays: z.ZodArray<z.ZodNumber>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"monthly">;
                    day: z.ZodNumber;
                    hour: z.ZodNumber;
                    minute: z.ZodNumber;
                }, z.core.$strict>], "kind">;
                timezone: z.ZodString;
                notifications: z.ZodBoolean;
            }, z.core.$strict>;
            execution: z.ZodObject<{
                class: z.ZodLiteral<"agent_turn">;
                budgetClass: z.ZodLiteral<"scheduled_occurrence">;
                audiencePolicyRef: z.ZodLiteral<"agent-room/current">;
                sourcePolicyRef: z.ZodLiteral<"agent-runtime/current">;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            profile: z.ZodLiteral<"atum.managed-sweep-extension/1">;
            source: z.ZodObject<{
                kind: z.ZodLiteral<"sweep">;
                agentPrincipal: z.ZodString;
                occurrenceScheduleId: z.ZodLiteral<"sys_followup_sweep_v1">;
            }, z.core.$strict>;
            sweep: z.ZodObject<{
                settingsRevision: z.ZodNumber;
                policyVersion: z.ZodLiteral<2>;
                policyDigest: z.ZodString;
                occurrenceDefinitionDigest: z.ZodString;
                intervalMs: z.ZodLiteral<7200000>;
                quietMs: z.ZodLiteral<600000>;
                normalStartHour: z.ZodLiteral<8>;
                normalEndHour: z.ZodLiteral<21>;
                warmupOffsetsMs: z.ZodTuple<[z.ZodLiteral<300000>, z.ZodLiteral<900000>, z.ZodLiteral<2100000>, z.ZodLiteral<3600000>], null>;
                warmupAnchorAt: z.ZodNullable<z.ZodNumber>;
                warmupNextIndex: z.ZodNullable<z.ZodNumber>;
                nextDueAt: z.ZodNumber;
                warmupNextDueAt: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            execution: z.ZodObject<{
                class: z.ZodLiteral<"sweep">;
                budgetClass: z.ZodLiteral<"sweep">;
                admission: z.ZodLiteral<"agent-sweep">;
                requestId: z.ZodLiteral<"armId">;
                executionProfile: z.ZodLiteral<"atum.native-sweep/1">;
            }, z.core.$strict>;
        }, z.core.$strict>]>;
        executionGeneration: z.ZodLiteral<0>;
        clockState: z.ZodLiteral<"projection_only">;
        runtime: z.ZodObject<{
            enabled: z.ZodBoolean;
            state: z.ZodEnum<{
                completed: "completed";
                paused: "paused";
                scheduled: "scheduled";
            }>;
            scheduledNextRunAt: z.ZodNullable<z.ZodNumber>;
            manualRunAt: z.ZodNullable<z.ZodNumber>;
            nextOccurrenceAt: z.ZodNullable<z.ZodNumber>;
            nextTrigger: z.ZodNullable<z.ZodEnum<{
                manual: "manual";
                scheduled: "scheduled";
            }>>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const ControllerJobsV2SnapshotSchema: z.ZodObject<{
    profile: z.ZodLiteral<"atum.controller-jobs/2">;
    agentPrincipal: z.ZodString;
    legacyState: z.ZodEnum<{
        unknown: "unknown";
        clear: "clear";
        present: "present";
    }>;
    jobs: z.ZodArray<z.ZodObject<{
        jobId: z.ZodString;
        definitionRevision: z.ZodNumber;
        definitionDigest: z.ZodString;
        nativeDefinition: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            prompt: z.ZodString;
            skills: z.ZodArray<z.ZodString>;
            skill: z.ZodNullable<z.ZodString>;
            model: z.ZodNullable<z.ZodString>;
            provider: z.ZodNullable<z.ZodString>;
            base_url: z.ZodNullable<z.ZodURL>;
            script: z.ZodNullable<z.ZodString>;
            no_agent: z.ZodBoolean;
            monitor_script: z.ZodNullable<z.ZodString>;
            monitor_url: z.ZodNullable<z.ZodURL>;
            context_from: z.ZodNullable<z.ZodArray<z.ZodString>>;
            schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"once">;
                run_at: z.ZodISODateTime;
                display: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"interval">;
                minutes: z.ZodNumber;
                display: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"cron">;
                expr: z.ZodString;
                display: z.ZodString;
            }, z.core.$strict>], "kind">;
            schedule_display: z.ZodString;
            repeat: z.ZodObject<{
                times: z.ZodNullable<z.ZodNumber>;
                completed: z.ZodLiteral<0>;
            }, z.core.$strict>;
            deliver: z.ZodLiteral<"origin">;
            origin: z.ZodObject<{
                platform: z.ZodLiteral<"atum">;
                kind: z.ZodLiteral<"managed_job">;
                job_id: z.ZodString;
            }, z.core.$strict>;
            enabled_toolsets: z.ZodNullable<z.ZodArray<z.ZodString>>;
            workdir: z.ZodNullable<z.ZodString>;
            attach_to_session: z.ZodLiteral<false>;
            reasoning_effort: z.ZodNullable<z.ZodEnum<{
                none: "none";
                low: "low";
                medium: "medium";
                high: "high";
                max: "max";
                minimal: "minimal";
                xhigh: "xhigh";
                ultra: "ultra";
            }>>;
            failure_deliver: z.ZodNullable<z.ZodString>;
            interpreter: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        atumExtension: z.ZodUnion<readonly [z.ZodObject<{
            profile: z.ZodLiteral<"atum.managed-job-extension/1">;
            source: z.ZodObject<{
                kind: z.ZodLiteral<"routine">;
                routineId: z.ZodString;
            }, z.core.$strict>;
            creator: z.ZodObject<{
                kind: z.ZodEnum<{
                    user: "user";
                    import: "import";
                    system: "system";
                }>;
                templateKey: z.ZodNullable<z.ZodString>;
                originalHomeJobId: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            routine: z.ZodObject<{
                schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"once">;
                    runAt: z.ZodISODateTime;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"daily">;
                    hour: z.ZodNumber;
                    minute: z.ZodNumber;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"weekly">;
                    hour: z.ZodNumber;
                    minute: z.ZodNumber;
                    weekdays: z.ZodArray<z.ZodNumber>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"monthly">;
                    day: z.ZodNumber;
                    hour: z.ZodNumber;
                    minute: z.ZodNumber;
                }, z.core.$strict>], "kind">;
                timezone: z.ZodString;
                notifications: z.ZodBoolean;
            }, z.core.$strict>;
            execution: z.ZodObject<{
                class: z.ZodLiteral<"agent_turn">;
                budgetClass: z.ZodLiteral<"scheduled_occurrence">;
                audiencePolicyRef: z.ZodLiteral<"agent-room/current">;
                sourcePolicyRef: z.ZodLiteral<"agent-runtime/current">;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            profile: z.ZodLiteral<"atum.managed-sweep-extension/1">;
            source: z.ZodObject<{
                kind: z.ZodLiteral<"sweep">;
                agentPrincipal: z.ZodString;
                occurrenceScheduleId: z.ZodLiteral<"sys_followup_sweep_v1">;
            }, z.core.$strict>;
            sweep: z.ZodObject<{
                settingsRevision: z.ZodNumber;
                policyVersion: z.ZodLiteral<2>;
                policyDigest: z.ZodString;
                occurrenceDefinitionDigest: z.ZodString;
                intervalMs: z.ZodLiteral<7200000>;
                quietMs: z.ZodLiteral<600000>;
                normalStartHour: z.ZodLiteral<8>;
                normalEndHour: z.ZodLiteral<21>;
                warmupOffsetsMs: z.ZodTuple<[z.ZodLiteral<300000>, z.ZodLiteral<900000>, z.ZodLiteral<2100000>, z.ZodLiteral<3600000>], null>;
                warmupAnchorAt: z.ZodNullable<z.ZodNumber>;
                warmupNextIndex: z.ZodNullable<z.ZodNumber>;
                nextDueAt: z.ZodNumber;
                warmupNextDueAt: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            execution: z.ZodObject<{
                class: z.ZodLiteral<"sweep">;
                budgetClass: z.ZodLiteral<"sweep">;
                admission: z.ZodLiteral<"agent-sweep">;
                requestId: z.ZodLiteral<"armId">;
                executionProfile: z.ZodLiteral<"atum.native-sweep/1">;
            }, z.core.$strict>;
        }, z.core.$strict>]>;
        executionGeneration: z.ZodNumber;
        clockState: z.ZodLiteral<"external">;
        runtime: z.ZodObject<{
            enabled: z.ZodBoolean;
            state: z.ZodEnum<{
                completed: "completed";
                paused: "paused";
                scheduled: "scheduled";
            }>;
            scheduledNextRunAt: z.ZodNullable<z.ZodNumber>;
            manualRunAt: z.ZodNullable<z.ZodNumber>;
            nextOccurrenceAt: z.ZodNullable<z.ZodNumber>;
            nextTrigger: z.ZodNullable<z.ZodEnum<{
                manual: "manual";
                scheduled: "scheduled";
            }>>;
        }, z.core.$strict>;
        arm: z.ZodNullable<z.ZodObject<{
            armId: z.ZodString;
            executionGeneration: z.ZodNumber;
            occurrenceAt: z.ZodNumber;
            nextTrigger: z.ZodEnum<{
                manual: "manual";
                scheduled: "scheduled";
            }>;
            catchupWindowMs: z.ZodNumber;
            state: z.ZodEnum<{
                claimed: "claimed";
                armed: "armed";
            }>;
            claimExpiresAt: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const ControllerJobReconcileRequestSchema: z.ZodObject<{
    profile: z.ZodEnum<{
        "atum.controller-job-reconcile/1": "atum.controller-job-reconcile/1";
        "atum.controller-job-reconcile/2": "atum.controller-job-reconcile/2";
    }>;
    operation: z.ZodLiteral<"reconcile">;
    leaseToken: z.ZodString;
}, z.core.$strict>;
export declare const ControllerJobFireRequestSchema: z.ZodUnion<readonly [z.ZodObject<{
    profile: z.ZodLiteral<"atum.controller-job-fire/1">;
    operation: z.ZodLiteral<"claim">;
    leaseToken: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    profile: z.ZodLiteral<"atum.controller-job-fire/1">;
    operation: z.ZodLiteral<"complete">;
    leaseToken: z.ZodString;
    armId: z.ZodString;
    occurrenceId: z.ZodString;
    outcome: z.ZodEnum<{
        queued: "queued";
        terminal: "terminal";
        missed: "missed";
    }>;
}, z.core.$strict>, z.ZodObject<{
    profile: z.ZodLiteral<"atum.controller-job-fire/1">;
    operation: z.ZodLiteral<"complete">;
    leaseToken: z.ZodString;
    armId: z.ZodString;
    occurrenceId: z.ZodNull;
    outcome: z.ZodLiteral<"daily_cap">;
}, z.core.$strict>]>;
export declare const ControllerJobFireClaimSchema: z.ZodObject<{
    jobId: z.ZodString;
    definitionRevision: z.ZodNumber;
    definitionDigest: z.ZodString;
    nativeDefinition: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        prompt: z.ZodString;
        skills: z.ZodArray<z.ZodString>;
        skill: z.ZodNullable<z.ZodString>;
        model: z.ZodNullable<z.ZodString>;
        provider: z.ZodNullable<z.ZodString>;
        base_url: z.ZodNullable<z.ZodURL>;
        script: z.ZodNullable<z.ZodString>;
        no_agent: z.ZodBoolean;
        monitor_script: z.ZodNullable<z.ZodString>;
        monitor_url: z.ZodNullable<z.ZodURL>;
        context_from: z.ZodNullable<z.ZodArray<z.ZodString>>;
        schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"once">;
            run_at: z.ZodISODateTime;
            display: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"interval">;
            minutes: z.ZodNumber;
            display: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"cron">;
            expr: z.ZodString;
            display: z.ZodString;
        }, z.core.$strict>], "kind">;
        schedule_display: z.ZodString;
        repeat: z.ZodObject<{
            times: z.ZodNullable<z.ZodNumber>;
            completed: z.ZodLiteral<0>;
        }, z.core.$strict>;
        deliver: z.ZodLiteral<"origin">;
        origin: z.ZodObject<{
            platform: z.ZodLiteral<"atum">;
            kind: z.ZodLiteral<"managed_job">;
            job_id: z.ZodString;
        }, z.core.$strict>;
        enabled_toolsets: z.ZodNullable<z.ZodArray<z.ZodString>>;
        workdir: z.ZodNullable<z.ZodString>;
        attach_to_session: z.ZodLiteral<false>;
        reasoning_effort: z.ZodNullable<z.ZodEnum<{
            none: "none";
            low: "low";
            medium: "medium";
            high: "high";
            max: "max";
            minimal: "minimal";
            xhigh: "xhigh";
            ultra: "ultra";
        }>>;
        failure_deliver: z.ZodNullable<z.ZodString>;
        interpreter: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    atumExtension: z.ZodUnion<readonly [z.ZodObject<{
        profile: z.ZodLiteral<"atum.managed-job-extension/1">;
        source: z.ZodObject<{
            kind: z.ZodLiteral<"routine">;
            routineId: z.ZodString;
        }, z.core.$strict>;
        creator: z.ZodObject<{
            kind: z.ZodEnum<{
                user: "user";
                import: "import";
                system: "system";
            }>;
            templateKey: z.ZodNullable<z.ZodString>;
            originalHomeJobId: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        routine: z.ZodObject<{
            schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"once">;
                runAt: z.ZodISODateTime;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"daily">;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"weekly">;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
                weekdays: z.ZodArray<z.ZodNumber>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"monthly">;
                day: z.ZodNumber;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
            }, z.core.$strict>], "kind">;
            timezone: z.ZodString;
            notifications: z.ZodBoolean;
        }, z.core.$strict>;
        execution: z.ZodObject<{
            class: z.ZodLiteral<"agent_turn">;
            budgetClass: z.ZodLiteral<"scheduled_occurrence">;
            audiencePolicyRef: z.ZodLiteral<"agent-room/current">;
            sourcePolicyRef: z.ZodLiteral<"agent-runtime/current">;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        profile: z.ZodLiteral<"atum.managed-sweep-extension/1">;
        source: z.ZodObject<{
            kind: z.ZodLiteral<"sweep">;
            agentPrincipal: z.ZodString;
            occurrenceScheduleId: z.ZodLiteral<"sys_followup_sweep_v1">;
        }, z.core.$strict>;
        sweep: z.ZodObject<{
            settingsRevision: z.ZodNumber;
            policyVersion: z.ZodLiteral<2>;
            policyDigest: z.ZodString;
            occurrenceDefinitionDigest: z.ZodString;
            intervalMs: z.ZodLiteral<7200000>;
            quietMs: z.ZodLiteral<600000>;
            normalStartHour: z.ZodLiteral<8>;
            normalEndHour: z.ZodLiteral<21>;
            warmupOffsetsMs: z.ZodTuple<[z.ZodLiteral<300000>, z.ZodLiteral<900000>, z.ZodLiteral<2100000>, z.ZodLiteral<3600000>], null>;
            warmupAnchorAt: z.ZodNullable<z.ZodNumber>;
            warmupNextIndex: z.ZodNullable<z.ZodNumber>;
            nextDueAt: z.ZodNumber;
            warmupNextDueAt: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        execution: z.ZodObject<{
            class: z.ZodLiteral<"sweep">;
            budgetClass: z.ZodLiteral<"sweep">;
            admission: z.ZodLiteral<"agent-sweep">;
            requestId: z.ZodLiteral<"armId">;
            executionProfile: z.ZodLiteral<"atum.native-sweep/1">;
        }, z.core.$strict>;
    }, z.core.$strict>]>;
    arm: z.ZodObject<{
        armId: z.ZodString;
        executionGeneration: z.ZodNumber;
        occurrenceAt: z.ZodNumber;
        nextTrigger: z.ZodEnum<{
            manual: "manual";
            scheduled: "scheduled";
        }>;
        catchupWindowMs: z.ZodNumber;
        claimExpiresAt: z.ZodNullable<z.ZodNumber>;
        state: z.ZodLiteral<"claimed">;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const ControllerJobFireResponseSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    profile: z.ZodLiteral<"atum.controller-job-fire/1">;
    operation: z.ZodLiteral<"claimed">;
    agentPrincipal: z.ZodString;
    fire: z.ZodNullable<z.ZodObject<{
        jobId: z.ZodString;
        definitionRevision: z.ZodNumber;
        definitionDigest: z.ZodString;
        nativeDefinition: z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            prompt: z.ZodString;
            skills: z.ZodArray<z.ZodString>;
            skill: z.ZodNullable<z.ZodString>;
            model: z.ZodNullable<z.ZodString>;
            provider: z.ZodNullable<z.ZodString>;
            base_url: z.ZodNullable<z.ZodURL>;
            script: z.ZodNullable<z.ZodString>;
            no_agent: z.ZodBoolean;
            monitor_script: z.ZodNullable<z.ZodString>;
            monitor_url: z.ZodNullable<z.ZodURL>;
            context_from: z.ZodNullable<z.ZodArray<z.ZodString>>;
            schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"once">;
                run_at: z.ZodISODateTime;
                display: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"interval">;
                minutes: z.ZodNumber;
                display: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"cron">;
                expr: z.ZodString;
                display: z.ZodString;
            }, z.core.$strict>], "kind">;
            schedule_display: z.ZodString;
            repeat: z.ZodObject<{
                times: z.ZodNullable<z.ZodNumber>;
                completed: z.ZodLiteral<0>;
            }, z.core.$strict>;
            deliver: z.ZodLiteral<"origin">;
            origin: z.ZodObject<{
                platform: z.ZodLiteral<"atum">;
                kind: z.ZodLiteral<"managed_job">;
                job_id: z.ZodString;
            }, z.core.$strict>;
            enabled_toolsets: z.ZodNullable<z.ZodArray<z.ZodString>>;
            workdir: z.ZodNullable<z.ZodString>;
            attach_to_session: z.ZodLiteral<false>;
            reasoning_effort: z.ZodNullable<z.ZodEnum<{
                none: "none";
                low: "low";
                medium: "medium";
                high: "high";
                max: "max";
                minimal: "minimal";
                xhigh: "xhigh";
                ultra: "ultra";
            }>>;
            failure_deliver: z.ZodNullable<z.ZodString>;
            interpreter: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        atumExtension: z.ZodUnion<readonly [z.ZodObject<{
            profile: z.ZodLiteral<"atum.managed-job-extension/1">;
            source: z.ZodObject<{
                kind: z.ZodLiteral<"routine">;
                routineId: z.ZodString;
            }, z.core.$strict>;
            creator: z.ZodObject<{
                kind: z.ZodEnum<{
                    user: "user";
                    import: "import";
                    system: "system";
                }>;
                templateKey: z.ZodNullable<z.ZodString>;
                originalHomeJobId: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>;
            routine: z.ZodObject<{
                schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"once">;
                    runAt: z.ZodISODateTime;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"daily">;
                    hour: z.ZodNumber;
                    minute: z.ZodNumber;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"weekly">;
                    hour: z.ZodNumber;
                    minute: z.ZodNumber;
                    weekdays: z.ZodArray<z.ZodNumber>;
                }, z.core.$strict>, z.ZodObject<{
                    kind: z.ZodLiteral<"monthly">;
                    day: z.ZodNumber;
                    hour: z.ZodNumber;
                    minute: z.ZodNumber;
                }, z.core.$strict>], "kind">;
                timezone: z.ZodString;
                notifications: z.ZodBoolean;
            }, z.core.$strict>;
            execution: z.ZodObject<{
                class: z.ZodLiteral<"agent_turn">;
                budgetClass: z.ZodLiteral<"scheduled_occurrence">;
                audiencePolicyRef: z.ZodLiteral<"agent-room/current">;
                sourcePolicyRef: z.ZodLiteral<"agent-runtime/current">;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            profile: z.ZodLiteral<"atum.managed-sweep-extension/1">;
            source: z.ZodObject<{
                kind: z.ZodLiteral<"sweep">;
                agentPrincipal: z.ZodString;
                occurrenceScheduleId: z.ZodLiteral<"sys_followup_sweep_v1">;
            }, z.core.$strict>;
            sweep: z.ZodObject<{
                settingsRevision: z.ZodNumber;
                policyVersion: z.ZodLiteral<2>;
                policyDigest: z.ZodString;
                occurrenceDefinitionDigest: z.ZodString;
                intervalMs: z.ZodLiteral<7200000>;
                quietMs: z.ZodLiteral<600000>;
                normalStartHour: z.ZodLiteral<8>;
                normalEndHour: z.ZodLiteral<21>;
                warmupOffsetsMs: z.ZodTuple<[z.ZodLiteral<300000>, z.ZodLiteral<900000>, z.ZodLiteral<2100000>, z.ZodLiteral<3600000>], null>;
                warmupAnchorAt: z.ZodNullable<z.ZodNumber>;
                warmupNextIndex: z.ZodNullable<z.ZodNumber>;
                nextDueAt: z.ZodNumber;
                warmupNextDueAt: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            execution: z.ZodObject<{
                class: z.ZodLiteral<"sweep">;
                budgetClass: z.ZodLiteral<"sweep">;
                admission: z.ZodLiteral<"agent-sweep">;
                requestId: z.ZodLiteral<"armId">;
                executionProfile: z.ZodLiteral<"atum.native-sweep/1">;
            }, z.core.$strict>;
        }, z.core.$strict>]>;
        arm: z.ZodObject<{
            armId: z.ZodString;
            executionGeneration: z.ZodNumber;
            occurrenceAt: z.ZodNumber;
            nextTrigger: z.ZodEnum<{
                manual: "manual";
                scheduled: "scheduled";
            }>;
            catchupWindowMs: z.ZodNumber;
            claimExpiresAt: z.ZodNullable<z.ZodNumber>;
            state: z.ZodLiteral<"claimed">;
        }, z.core.$strict>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    profile: z.ZodLiteral<"atum.controller-job-fire/1">;
    operation: z.ZodLiteral<"completed">;
    agentPrincipal: z.ZodString;
    armId: z.ZodString;
    occurrenceId: z.ZodNullable<z.ZodString>;
    outcome: z.ZodEnum<{
        daily_cap: "daily_cap";
        queued: "queued";
        terminal: "terminal";
        missed: "missed";
    }>;
}, z.core.$strict>], "operation">;
export declare const ControllerJobResolveRequestSchema: z.ZodObject<{
    profile: z.ZodLiteral<"atum.controller-job-resolve/1">;
    jobId: z.ZodString;
    definitionRevision: z.ZodNumber;
    definitionDigest: z.ZodString;
}, z.core.$strict>;
export declare const ControllerJobDefinitionResponseSchema: z.ZodObject<{
    jobId: z.ZodString;
    definitionRevision: z.ZodNumber;
    definitionDigest: z.ZodString;
    nativeDefinition: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        prompt: z.ZodString;
        skills: z.ZodArray<z.ZodString>;
        skill: z.ZodNullable<z.ZodString>;
        model: z.ZodNullable<z.ZodString>;
        provider: z.ZodNullable<z.ZodString>;
        base_url: z.ZodNullable<z.ZodURL>;
        script: z.ZodNullable<z.ZodString>;
        no_agent: z.ZodBoolean;
        monitor_script: z.ZodNullable<z.ZodString>;
        monitor_url: z.ZodNullable<z.ZodURL>;
        context_from: z.ZodNullable<z.ZodArray<z.ZodString>>;
        schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"once">;
            run_at: z.ZodISODateTime;
            display: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"interval">;
            minutes: z.ZodNumber;
            display: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"cron">;
            expr: z.ZodString;
            display: z.ZodString;
        }, z.core.$strict>], "kind">;
        schedule_display: z.ZodString;
        repeat: z.ZodObject<{
            times: z.ZodNullable<z.ZodNumber>;
            completed: z.ZodLiteral<0>;
        }, z.core.$strict>;
        deliver: z.ZodLiteral<"origin">;
        origin: z.ZodObject<{
            platform: z.ZodLiteral<"atum">;
            kind: z.ZodLiteral<"managed_job">;
            job_id: z.ZodString;
        }, z.core.$strict>;
        enabled_toolsets: z.ZodNullable<z.ZodArray<z.ZodString>>;
        workdir: z.ZodNullable<z.ZodString>;
        attach_to_session: z.ZodLiteral<false>;
        reasoning_effort: z.ZodNullable<z.ZodEnum<{
            none: "none";
            low: "low";
            medium: "medium";
            high: "high";
            max: "max";
            minimal: "minimal";
            xhigh: "xhigh";
            ultra: "ultra";
        }>>;
        failure_deliver: z.ZodNullable<z.ZodString>;
        interpreter: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    atumExtension: z.ZodUnion<readonly [z.ZodObject<{
        profile: z.ZodLiteral<"atum.managed-job-extension/1">;
        source: z.ZodObject<{
            kind: z.ZodLiteral<"routine">;
            routineId: z.ZodString;
        }, z.core.$strict>;
        creator: z.ZodObject<{
            kind: z.ZodEnum<{
                user: "user";
                import: "import";
                system: "system";
            }>;
            templateKey: z.ZodNullable<z.ZodString>;
            originalHomeJobId: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        routine: z.ZodObject<{
            schedule: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"once">;
                runAt: z.ZodISODateTime;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"daily">;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"weekly">;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
                weekdays: z.ZodArray<z.ZodNumber>;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"monthly">;
                day: z.ZodNumber;
                hour: z.ZodNumber;
                minute: z.ZodNumber;
            }, z.core.$strict>], "kind">;
            timezone: z.ZodString;
            notifications: z.ZodBoolean;
        }, z.core.$strict>;
        execution: z.ZodObject<{
            class: z.ZodLiteral<"agent_turn">;
            budgetClass: z.ZodLiteral<"scheduled_occurrence">;
            audiencePolicyRef: z.ZodLiteral<"agent-room/current">;
            sourcePolicyRef: z.ZodLiteral<"agent-runtime/current">;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        profile: z.ZodLiteral<"atum.managed-sweep-extension/1">;
        source: z.ZodObject<{
            kind: z.ZodLiteral<"sweep">;
            agentPrincipal: z.ZodString;
            occurrenceScheduleId: z.ZodLiteral<"sys_followup_sweep_v1">;
        }, z.core.$strict>;
        sweep: z.ZodObject<{
            settingsRevision: z.ZodNumber;
            policyVersion: z.ZodLiteral<2>;
            policyDigest: z.ZodString;
            occurrenceDefinitionDigest: z.ZodString;
            intervalMs: z.ZodLiteral<7200000>;
            quietMs: z.ZodLiteral<600000>;
            normalStartHour: z.ZodLiteral<8>;
            normalEndHour: z.ZodLiteral<21>;
            warmupOffsetsMs: z.ZodTuple<[z.ZodLiteral<300000>, z.ZodLiteral<900000>, z.ZodLiteral<2100000>, z.ZodLiteral<3600000>], null>;
            warmupAnchorAt: z.ZodNullable<z.ZodNumber>;
            warmupNextIndex: z.ZodNullable<z.ZodNumber>;
            nextDueAt: z.ZodNumber;
            warmupNextDueAt: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        execution: z.ZodObject<{
            class: z.ZodLiteral<"sweep">;
            budgetClass: z.ZodLiteral<"sweep">;
            admission: z.ZodLiteral<"agent-sweep">;
            requestId: z.ZodLiteral<"armId">;
            executionProfile: z.ZodLiteral<"atum.native-sweep/1">;
        }, z.core.$strict>;
    }, z.core.$strict>]>;
    profile: z.ZodLiteral<"atum.controller-job-definition/1">;
    agentPrincipal: z.ZodString;
}, z.core.$strict>;
export type HermesCronSchedule = z.infer<typeof HermesCronScheduleSchema>;
export type HermesCronJobDefinition = z.infer<typeof HermesCronJobDefinitionSchema>;
export type ManagedJobExtension = z.infer<typeof ManagedJobExtensionSchema>;
export type ControllerJobRuntime = z.infer<typeof ControllerJobRuntimeSchema>;
export type ControllerJobDefinition = z.infer<typeof ControllerJobDefinitionSchema>;
export type ControllerJob = z.infer<typeof ControllerJobSchema>;
export type ControllerJobsSnapshot = z.infer<typeof ControllerJobsSnapshotSchema>;
export type ControllerJobArm = z.infer<typeof ControllerJobArmSchema>;
export type ManagedControllerJob = z.infer<typeof ManagedControllerJobSchema>;
export type ControllerJobsV2Snapshot = z.infer<typeof ControllerJobsV2SnapshotSchema>;
export type ControllerJobReconcileRequest = z.infer<typeof ControllerJobReconcileRequestSchema>;
export type ControllerJobFireRequest = z.infer<typeof ControllerJobFireRequestSchema>;
export type ControllerJobFireClaim = z.infer<typeof ControllerJobFireClaimSchema>;
export type ControllerJobFireResponse = z.infer<typeof ControllerJobFireResponseSchema>;
export type ControllerJobResolveRequest = z.infer<typeof ControllerJobResolveRequestSchema>;
export type ControllerJobDefinitionResponse = z.infer<typeof ControllerJobDefinitionResponseSchema>;
//# sourceMappingURL=scheduled-jobs.d.ts.map