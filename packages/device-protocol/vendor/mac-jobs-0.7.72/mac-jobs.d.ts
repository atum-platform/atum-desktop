import { z } from "zod";
export declare const MAC_JOB_SIGNATURE_ACTIONS: {
    readonly "job-snapshot": "MacJobSnapshot";
    readonly "job-fire": "MacJobFire";
    readonly "job-occurrence": "MacJobOccurrence";
    readonly "job-grant": "MacJobGrant";
};
export declare const MacJobOccurrenceRequestSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    operation: z.ZodLiteral<"claim">;
    leaseToken: z.ZodString;
    scheduleId: z.ZodString;
    occurrenceAt: z.ZodNumber;
    definitionDigest: z.ZodString;
    catchupWindowMs: z.ZodNumber;
    roomId: z.ZodString;
    executorId: z.ZodString;
    protocol: z.ZodLiteral<3>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"dispatch">;
    leaseToken: z.ZodString;
    occurrenceId: z.ZodString;
    executorId: z.ZodString;
    protocol: z.ZodLiteral<3>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"complete">;
    occurrenceId: z.ZodString;
    outcome: z.ZodEnum<{
        failed: "failed";
        stopped: "stopped";
        uncertain: "uncertain";
        answered: "answered";
    }>;
    usage: z.ZodObject<{
        computeSeconds: z.ZodNumber;
    }, z.core.$strict>;
    executorId: z.ZodString;
    protocol: z.ZodLiteral<3>;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"published">;
    occurrenceId: z.ZodString;
    publishedEvent: z.ZodString;
    executorId: z.ZodString;
    protocol: z.ZodLiteral<3>;
}, z.core.$strict>], "operation">;
export declare const MacJobFireEnvelopeSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
        signer: z.ZodLiteral<"mac_executor">;
    }, z.core.$strict>;
    home: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    request: z.ZodUnion<readonly [z.ZodObject<{
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
}, z.core.$strict>;
export declare const MacJobOccurrenceEnvelopeSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
        signer: z.ZodLiteral<"mac_executor">;
    }, z.core.$strict>;
    home: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    request: z.ZodDiscriminatedUnion<[z.ZodObject<{
        operation: z.ZodLiteral<"claim">;
        leaseToken: z.ZodString;
        scheduleId: z.ZodString;
        occurrenceAt: z.ZodNumber;
        definitionDigest: z.ZodString;
        catchupWindowMs: z.ZodNumber;
        roomId: z.ZodString;
        executorId: z.ZodString;
        protocol: z.ZodLiteral<3>;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"dispatch">;
        leaseToken: z.ZodString;
        occurrenceId: z.ZodString;
        executorId: z.ZodString;
        protocol: z.ZodLiteral<3>;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"complete">;
        occurrenceId: z.ZodString;
        outcome: z.ZodEnum<{
            failed: "failed";
            stopped: "stopped";
            uncertain: "uncertain";
            answered: "answered";
        }>;
        usage: z.ZodObject<{
            computeSeconds: z.ZodNumber;
        }, z.core.$strict>;
        executorId: z.ZodString;
        protocol: z.ZodLiteral<3>;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"published">;
        occurrenceId: z.ZodString;
        publishedEvent: z.ZodString;
        executorId: z.ZodString;
        protocol: z.ZodLiteral<3>;
    }, z.core.$strict>], "operation">;
}, z.core.$strict>;
export declare const MacJobGrantEnvelopeSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
        signer: z.ZodLiteral<"mac_executor">;
    }, z.core.$strict>;
    home: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    request: z.ZodObject<{
        token: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const MacJobPlacementReasonSchema: z.ZodEnum<{
    lease_expired: "lease_expired";
    stale_home_epoch: "stale_home_epoch";
    stale_executor_term: "stale_executor_term";
    wrong_lease: "wrong_lease";
    wrong_signer_location: "wrong_signer_location";
    move_in_progress: "move_in_progress";
}>;
export declare const MacJobRefusalSchema: z.ZodUnion<readonly [z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-fire/1">;
    code: z.ZodLiteral<"lease_lost">;
    detail: z.ZodObject<{
        kind: z.ZodLiteral<"placement_authority">;
        reason: z.ZodEnum<{
            lease_expired: "lease_expired";
            stale_home_epoch: "stale_home_epoch";
            stale_executor_term: "stale_executor_term";
            wrong_lease: "wrong_lease";
            wrong_signer_location: "wrong_signer_location";
            move_in_progress: "move_in_progress";
        }>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-fire/1">;
    code: z.ZodEnum<{
        not_found: "not_found";
        unavailable: "unavailable";
        denied: "denied";
        conflict: "conflict";
        busy: "busy";
        matrix_invalid: "matrix_invalid";
    }>;
}, z.core.$strict>]>;
export declare const MacJobModelGrantSchema: z.ZodUnion<readonly [z.ZodObject<{
    token: z.ZodString;
    effort: z.ZodString;
    policyDigest: z.ZodString;
    expiresAt: z.ZodNumber;
    aliases: z.ZodArray<z.ZodString>;
    ceilingMicroProtons: z.ZodNumber;
    funding: z.ZodEnum<{
        wallet: "wallet";
        trial: "trial";
    }>;
    alias: z.ZodString;
    model: z.ZodString;
    contextBudget: z.ZodNumber;
    outputBudget: z.ZodNumber;
    maxTurnMicroProtons: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    token: z.ZodString;
    googlePolicy: z.ZodLiteral<"limited_use_v1">;
    latchState: z.ZodEnum<{
        eligible: "eligible";
        latched: "latched";
    }>;
    expiresAt: z.ZodNumber;
    aliases: z.ZodArray<z.ZodString>;
    ceilingMicroProtons: z.ZodNumber;
    funding: z.ZodEnum<{
        wallet: "wallet";
        trial: "trial";
    }>;
    alias: z.ZodString;
    model: z.ZodString;
    contextBudget: z.ZodNumber;
    outputBudget: z.ZodNumber;
    maxTurnMicroProtons: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    token: z.ZodString;
    funding: z.ZodLiteral<"subscription">;
    source: z.ZodLiteral<"opencode_go">;
    provider: z.ZodLiteral<"opencode_go">;
    connectionRevision: z.ZodNumber;
    effort: z.ZodString;
    policyDigest: z.ZodString;
    expiresAt: z.ZodNumber;
    aliases: z.ZodArray<z.ZodString>;
    ceilingMicroProtons: z.ZodNumber;
    alias: z.ZodString;
    model: z.ZodString;
    contextBudget: z.ZodNumber;
    outputBudget: z.ZodNumber;
    maxTurnMicroProtons: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    token: z.ZodString;
    funding: z.ZodLiteral<"subscription">;
    source: z.ZodLiteral<"chatgpt_plan">;
    provider: z.ZodLiteral<"openai-codex">;
    relayRevision: z.ZodNumber;
    relayDeviceServiceId: z.ZodString;
    effort: z.ZodString;
    policyDigest: z.ZodString;
    expiresAt: z.ZodNumber;
    aliases: z.ZodArray<z.ZodString>;
    ceilingMicroProtons: z.ZodNumber;
    alias: z.ZodString;
    model: z.ZodString;
    contextBudget: z.ZodNumber;
    outputBudget: z.ZodNumber;
    maxTurnMicroProtons: z.ZodNumber;
}, z.core.$strict>]>;
export declare const MacJobGrantResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    state: z.ZodLiteral<"revoked">;
}, z.core.$strict>, z.ZodObject<{
    effort: z.ZodString;
    policyDigest: z.ZodString;
    state: z.ZodLiteral<"active">;
    owner: z.ZodString;
    agentPrincipal: z.ZodString;
    reservationId: z.ZodString;
    expiresAt: z.ZodNumber;
    aliases: z.ZodArray<z.ZodString>;
    ceilingMicroProtons: z.ZodNumber;
    funding: z.ZodEnum<{
        wallet: "wallet";
        trial: "trial";
    }>;
    alias: z.ZodString;
    model: z.ZodString;
    contextBudget: z.ZodNumber;
    outputBudget: z.ZodNumber;
    maxTurnMicroProtons: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    googlePolicy: z.ZodLiteral<"limited_use_v1">;
    latchState: z.ZodEnum<{
        eligible: "eligible";
        latched: "latched";
    }>;
    state: z.ZodLiteral<"active">;
    owner: z.ZodString;
    agentPrincipal: z.ZodString;
    reservationId: z.ZodString;
    expiresAt: z.ZodNumber;
    aliases: z.ZodArray<z.ZodString>;
    ceilingMicroProtons: z.ZodNumber;
    funding: z.ZodEnum<{
        wallet: "wallet";
        trial: "trial";
    }>;
    alias: z.ZodString;
    model: z.ZodString;
    contextBudget: z.ZodNumber;
    outputBudget: z.ZodNumber;
    maxTurnMicroProtons: z.ZodNumber;
}, z.core.$strict>]>;
export declare const MacJobOccurrenceResultSchema: z.ZodObject<{
    occurrenceId: z.ZodString;
    state: z.ZodEnum<{
        completed: "completed";
        skipped: "skipped";
        claimed: "claimed";
        dispatched: "dispatched";
    }>;
    scheduleId: z.ZodString;
    occurrenceAt: z.ZodNumber;
    agentPrincipal: z.ZodString;
    executorId: z.ZodString;
    roomId: z.ZodString;
    expiresAt: z.ZodOptional<z.ZodNumber>;
    skipReason: z.ZodOptional<z.ZodEnum<{
        revoked: "revoked";
        unfunded: "unfunded";
        stopped: "stopped";
        missed: "missed";
        released: "released";
        capacity_unavailable: "capacity_unavailable";
        access_ended: "access_ended";
    }>>;
    transactionId: z.ZodOptional<z.ZodString>;
    publishedEvent: z.ZodOptional<z.ZodString>;
    outcome: z.ZodOptional<z.ZodEnum<{
        failed: "failed";
        stopped: "stopped";
        uncertain: "uncertain";
        answered: "answered";
    }>>;
    deliveryDisposition: z.ZodOptional<z.ZodEnum<{
        silent: "silent";
        delivered: "delivered";
    }>>;
    resume: z.ZodOptional<z.ZodObject<{
        attempt: z.ZodNumber;
        effect: z.ZodEnum<{
            none: "none";
            read_only: "read_only";
            side_effect_possible: "side_effect_possible";
        }>;
        tools: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    occurrenceOutcome: z.ZodOptional<z.ZodObject<{
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
    }, z.core.$strict>>;
    budget: z.ZodOptional<z.ZodObject<{
        reservationId: z.ZodString;
        funding: z.ZodEnum<{
            wallet: "wallet";
            trial: "trial";
        }>;
        ceilingMicroProtons: z.ZodNumber;
        computeSeconds: z.ZodNumber;
        firstAdmission: z.ZodBoolean;
    }, z.core.$strict>>;
    grants: z.ZodOptional<z.ZodObject<{
        model: z.ZodUnion<readonly [z.ZodObject<{
            token: z.ZodString;
            effort: z.ZodString;
            policyDigest: z.ZodString;
            expiresAt: z.ZodNumber;
            aliases: z.ZodArray<z.ZodString>;
            ceilingMicroProtons: z.ZodNumber;
            funding: z.ZodEnum<{
                wallet: "wallet";
                trial: "trial";
            }>;
            alias: z.ZodString;
            model: z.ZodString;
            contextBudget: z.ZodNumber;
            outputBudget: z.ZodNumber;
            maxTurnMicroProtons: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            token: z.ZodString;
            googlePolicy: z.ZodLiteral<"limited_use_v1">;
            latchState: z.ZodEnum<{
                eligible: "eligible";
                latched: "latched";
            }>;
            expiresAt: z.ZodNumber;
            aliases: z.ZodArray<z.ZodString>;
            ceilingMicroProtons: z.ZodNumber;
            funding: z.ZodEnum<{
                wallet: "wallet";
                trial: "trial";
            }>;
            alias: z.ZodString;
            model: z.ZodString;
            contextBudget: z.ZodNumber;
            outputBudget: z.ZodNumber;
            maxTurnMicroProtons: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            token: z.ZodString;
            funding: z.ZodLiteral<"subscription">;
            source: z.ZodLiteral<"opencode_go">;
            provider: z.ZodLiteral<"opencode_go">;
            connectionRevision: z.ZodNumber;
            effort: z.ZodString;
            policyDigest: z.ZodString;
            expiresAt: z.ZodNumber;
            aliases: z.ZodArray<z.ZodString>;
            ceilingMicroProtons: z.ZodNumber;
            alias: z.ZodString;
            model: z.ZodString;
            contextBudget: z.ZodNumber;
            outputBudget: z.ZodNumber;
            maxTurnMicroProtons: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            token: z.ZodString;
            funding: z.ZodLiteral<"subscription">;
            source: z.ZodLiteral<"chatgpt_plan">;
            provider: z.ZodLiteral<"openai-codex">;
            relayRevision: z.ZodNumber;
            relayDeviceServiceId: z.ZodString;
            effort: z.ZodString;
            policyDigest: z.ZodString;
            expiresAt: z.ZodNumber;
            aliases: z.ZodArray<z.ZodString>;
            ceilingMicroProtons: z.ZodNumber;
            alias: z.ZodString;
            model: z.ZodString;
            contextBudget: z.ZodNumber;
            outputBudget: z.ZodNumber;
            maxTurnMicroProtons: z.ZodNumber;
        }, z.core.$strict>]>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const MacJobFireResponseSchema: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
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
}, z.core.$strict>], "operation">, z.ZodUnion<readonly [z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-fire/1">;
    code: z.ZodLiteral<"lease_lost">;
    detail: z.ZodObject<{
        kind: z.ZodLiteral<"placement_authority">;
        reason: z.ZodEnum<{
            lease_expired: "lease_expired";
            stale_home_epoch: "stale_home_epoch";
            stale_executor_term: "stale_executor_term";
            wrong_lease: "wrong_lease";
            wrong_signer_location: "wrong_signer_location";
            move_in_progress: "move_in_progress";
        }>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-fire/1">;
    code: z.ZodEnum<{
        not_found: "not_found";
        unavailable: "unavailable";
        denied: "denied";
        conflict: "conflict";
        busy: "busy";
        matrix_invalid: "matrix_invalid";
    }>;
}, z.core.$strict>]>]>;
export declare const MacJobOccurrenceResponseSchema: z.ZodUnion<readonly [z.ZodObject<{
    occurrenceId: z.ZodString;
    state: z.ZodEnum<{
        completed: "completed";
        skipped: "skipped";
        claimed: "claimed";
        dispatched: "dispatched";
    }>;
    scheduleId: z.ZodString;
    occurrenceAt: z.ZodNumber;
    agentPrincipal: z.ZodString;
    executorId: z.ZodString;
    roomId: z.ZodString;
    expiresAt: z.ZodOptional<z.ZodNumber>;
    skipReason: z.ZodOptional<z.ZodEnum<{
        revoked: "revoked";
        unfunded: "unfunded";
        stopped: "stopped";
        missed: "missed";
        released: "released";
        capacity_unavailable: "capacity_unavailable";
        access_ended: "access_ended";
    }>>;
    transactionId: z.ZodOptional<z.ZodString>;
    publishedEvent: z.ZodOptional<z.ZodString>;
    outcome: z.ZodOptional<z.ZodEnum<{
        failed: "failed";
        stopped: "stopped";
        uncertain: "uncertain";
        answered: "answered";
    }>>;
    deliveryDisposition: z.ZodOptional<z.ZodEnum<{
        silent: "silent";
        delivered: "delivered";
    }>>;
    resume: z.ZodOptional<z.ZodObject<{
        attempt: z.ZodNumber;
        effect: z.ZodEnum<{
            none: "none";
            read_only: "read_only";
            side_effect_possible: "side_effect_possible";
        }>;
        tools: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    occurrenceOutcome: z.ZodOptional<z.ZodObject<{
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
    }, z.core.$strict>>;
    budget: z.ZodOptional<z.ZodObject<{
        reservationId: z.ZodString;
        funding: z.ZodEnum<{
            wallet: "wallet";
            trial: "trial";
        }>;
        ceilingMicroProtons: z.ZodNumber;
        computeSeconds: z.ZodNumber;
        firstAdmission: z.ZodBoolean;
    }, z.core.$strict>>;
    grants: z.ZodOptional<z.ZodObject<{
        model: z.ZodUnion<readonly [z.ZodObject<{
            token: z.ZodString;
            effort: z.ZodString;
            policyDigest: z.ZodString;
            expiresAt: z.ZodNumber;
            aliases: z.ZodArray<z.ZodString>;
            ceilingMicroProtons: z.ZodNumber;
            funding: z.ZodEnum<{
                wallet: "wallet";
                trial: "trial";
            }>;
            alias: z.ZodString;
            model: z.ZodString;
            contextBudget: z.ZodNumber;
            outputBudget: z.ZodNumber;
            maxTurnMicroProtons: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            token: z.ZodString;
            googlePolicy: z.ZodLiteral<"limited_use_v1">;
            latchState: z.ZodEnum<{
                eligible: "eligible";
                latched: "latched";
            }>;
            expiresAt: z.ZodNumber;
            aliases: z.ZodArray<z.ZodString>;
            ceilingMicroProtons: z.ZodNumber;
            funding: z.ZodEnum<{
                wallet: "wallet";
                trial: "trial";
            }>;
            alias: z.ZodString;
            model: z.ZodString;
            contextBudget: z.ZodNumber;
            outputBudget: z.ZodNumber;
            maxTurnMicroProtons: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            token: z.ZodString;
            funding: z.ZodLiteral<"subscription">;
            source: z.ZodLiteral<"opencode_go">;
            provider: z.ZodLiteral<"opencode_go">;
            connectionRevision: z.ZodNumber;
            effort: z.ZodString;
            policyDigest: z.ZodString;
            expiresAt: z.ZodNumber;
            aliases: z.ZodArray<z.ZodString>;
            ceilingMicroProtons: z.ZodNumber;
            alias: z.ZodString;
            model: z.ZodString;
            contextBudget: z.ZodNumber;
            outputBudget: z.ZodNumber;
            maxTurnMicroProtons: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            token: z.ZodString;
            funding: z.ZodLiteral<"subscription">;
            source: z.ZodLiteral<"chatgpt_plan">;
            provider: z.ZodLiteral<"openai-codex">;
            relayRevision: z.ZodNumber;
            relayDeviceServiceId: z.ZodString;
            effort: z.ZodString;
            policyDigest: z.ZodString;
            expiresAt: z.ZodNumber;
            aliases: z.ZodArray<z.ZodString>;
            ceilingMicroProtons: z.ZodNumber;
            alias: z.ZodString;
            model: z.ZodString;
            contextBudget: z.ZodNumber;
            outputBudget: z.ZodNumber;
            maxTurnMicroProtons: z.ZodNumber;
        }, z.core.$strict>]>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodUnion<readonly [z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-fire/1">;
    code: z.ZodLiteral<"lease_lost">;
    detail: z.ZodObject<{
        kind: z.ZodLiteral<"placement_authority">;
        reason: z.ZodEnum<{
            lease_expired: "lease_expired";
            stale_home_epoch: "stale_home_epoch";
            stale_executor_term: "stale_executor_term";
            wrong_lease: "wrong_lease";
            wrong_signer_location: "wrong_signer_location";
            move_in_progress: "move_in_progress";
        }>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-fire/1">;
    code: z.ZodEnum<{
        not_found: "not_found";
        unavailable: "unavailable";
        denied: "denied";
        conflict: "conflict";
        busy: "busy";
        matrix_invalid: "matrix_invalid";
    }>;
}, z.core.$strict>]>]>;
export declare const MacJobGrantResponseSchema: z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodObject<{
    state: z.ZodLiteral<"revoked">;
}, z.core.$strict>, z.ZodObject<{
    effort: z.ZodString;
    policyDigest: z.ZodString;
    state: z.ZodLiteral<"active">;
    owner: z.ZodString;
    agentPrincipal: z.ZodString;
    reservationId: z.ZodString;
    expiresAt: z.ZodNumber;
    aliases: z.ZodArray<z.ZodString>;
    ceilingMicroProtons: z.ZodNumber;
    funding: z.ZodEnum<{
        wallet: "wallet";
        trial: "trial";
    }>;
    alias: z.ZodString;
    model: z.ZodString;
    contextBudget: z.ZodNumber;
    outputBudget: z.ZodNumber;
    maxTurnMicroProtons: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    googlePolicy: z.ZodLiteral<"limited_use_v1">;
    latchState: z.ZodEnum<{
        eligible: "eligible";
        latched: "latched";
    }>;
    state: z.ZodLiteral<"active">;
    owner: z.ZodString;
    agentPrincipal: z.ZodString;
    reservationId: z.ZodString;
    expiresAt: z.ZodNumber;
    aliases: z.ZodArray<z.ZodString>;
    ceilingMicroProtons: z.ZodNumber;
    funding: z.ZodEnum<{
        wallet: "wallet";
        trial: "trial";
    }>;
    alias: z.ZodString;
    model: z.ZodString;
    contextBudget: z.ZodNumber;
    outputBudget: z.ZodNumber;
    maxTurnMicroProtons: z.ZodNumber;
}, z.core.$strict>]>, z.ZodUnion<readonly [z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-fire/1">;
    code: z.ZodLiteral<"lease_lost">;
    detail: z.ZodObject<{
        kind: z.ZodLiteral<"placement_authority">;
        reason: z.ZodEnum<{
            lease_expired: "lease_expired";
            stale_home_epoch: "stale_home_epoch";
            stale_executor_term: "stale_executor_term";
            wrong_lease: "wrong_lease";
            wrong_signer_location: "wrong_signer_location";
            move_in_progress: "move_in_progress";
        }>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-fire/1">;
    code: z.ZodEnum<{
        not_found: "not_found";
        unavailable: "unavailable";
        denied: "denied";
        conflict: "conflict";
        busy: "busy";
        matrix_invalid: "matrix_invalid";
    }>;
}, z.core.$strict>]>]>;
export type MacJobFireEnvelope = z.infer<typeof MacJobFireEnvelopeSchema>;
export type MacJobOccurrenceEnvelope = z.infer<typeof MacJobOccurrenceEnvelopeSchema>;
export type MacJobGrantEnvelope = z.infer<typeof MacJobGrantEnvelopeSchema>;
export type MacJobRefusal = z.infer<typeof MacJobRefusalSchema>;
export type MacJobOccurrenceRequest = z.infer<typeof MacJobOccurrenceRequestSchema>;
export type MacJobFireResponse = z.infer<typeof MacJobFireResponseSchema>;
export type MacJobOccurrenceResponse = z.infer<typeof MacJobOccurrenceResponseSchema>;
export type MacJobGrantResponse = z.infer<typeof MacJobGrantResponseSchema>;
export declare const MacJobSnapshotEnvelopeSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
        signer: z.ZodLiteral<"mac_executor">;
    }, z.core.$strict>;
    home: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.mac-job-snapshot/1">;
}, z.core.$strict>;
export declare const MacJobSnapshotResultSchema: z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-snapshot/1">;
    selected: z.ZodBoolean;
    generation: z.ZodNullable<z.ZodString>;
    managedJobIds: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const MacJobSnapshotResponseSchema: z.ZodUnion<readonly [z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-snapshot/1">;
    selected: z.ZodBoolean;
    generation: z.ZodNullable<z.ZodString>;
    managedJobIds: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodUnion<readonly [z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-fire/1">;
    code: z.ZodLiteral<"lease_lost">;
    detail: z.ZodObject<{
        kind: z.ZodLiteral<"placement_authority">;
        reason: z.ZodEnum<{
            lease_expired: "lease_expired";
            stale_home_epoch: "stale_home_epoch";
            stale_executor_term: "stale_executor_term";
            wrong_lease: "wrong_lease";
            wrong_signer_location: "wrong_signer_location";
            move_in_progress: "move_in_progress";
        }>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    profile: z.ZodLiteral<"atum.mac-job-fire/1">;
    code: z.ZodEnum<{
        not_found: "not_found";
        unavailable: "unavailable";
        denied: "denied";
        conflict: "conflict";
        busy: "busy";
        matrix_invalid: "matrix_invalid";
    }>;
}, z.core.$strict>]>]>;
export type MacJobSnapshotEnvelope = z.infer<typeof MacJobSnapshotEnvelopeSchema>;
export type MacJobSnapshotResponse = z.infer<typeof MacJobSnapshotResponseSchema>;
export declare const MAC_JOB_MODEL_SIGNATURE_HEADER = "x-atum-mac-job-signature";
export declare const MacJobModelEnvelopeSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
        signer: z.ZodLiteral<"mac_executor">;
    }, z.core.$strict>;
    home: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    request: z.ZodObject<{
        method: z.ZodLiteral<"POST">;
        path: z.ZodString;
        grantDigest: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type MacJobModelEnvelope = z.infer<typeof MacJobModelEnvelopeSchema>;
//# sourceMappingURL=mac-jobs.d.ts.map