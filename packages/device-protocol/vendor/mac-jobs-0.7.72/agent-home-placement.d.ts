import { z } from "zod";
export declare const AGENT_HOME_PLACEMENT_PROFILE: "atum.agent-home/2.1";
export declare const AGENT_HOME_UNLEDGERED_PUBLICATION_PROFILE: "atum.agent-home/2.3";
export declare const AGENT_HOME_UNLEDGERED_PUBLICATION_KINDS: readonly ["notice", "routine_result", "group_notice", "task_event", "task_file"];
export declare const AGENT_HOME_UNLEDGERED_PUBLICATION_MAX_PAYLOAD_BYTES = 131072;
export declare const AGENT_HOME_UNLEDGERED_PUBLICATION_MAX_CLIENT_KEY_BYTES = 255;
export declare const AGENT_HOME_DEFAULT_CHECKPOINT_CADENCE_MS = 900000;
export declare const AGENT_HOME_DEFAULT_FAILOVER_DELAY_MS = 900000;
export declare const AGENT_HOME_DEFAULT_ELIGIBILITY_SWEEP_MS = 60000;
export declare const AGENT_HOME_DEFAULT_BACKUP_ENABLED = true;
export declare const AGENT_HOME_DEFAULT_RETURN_MODE: "stay_put";
export declare const AgentHomeLocationSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"cloud">;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"mac">;
    deviceServiceId: z.ZodString;
}, z.core.$strict>], "kind">;
export type AgentHomeLocation = z.infer<typeof AgentHomeLocationSchema>;
export declare const AgentHomePortableCategorySchema: z.ZodEnum<{
    skills: "skills";
    memory: "memory";
    non_secret_config: "non_secret_config";
    routine_definitions: "routine_definitions";
    portable_app_data: "portable_app_data";
}>;
export type AgentHomePortableCategory = z.infer<typeof AgentHomePortableCategorySchema>;
export declare const AgentHomePortableSkipReasonSchema: z.ZodEnum<{
    invalid_relative_path: "invalid_relative_path";
    outside_category: "outside_category";
    credential_or_key_material: "credential_or_key_material";
    browser_profile: "browser_profile";
    database_or_sidecar: "database_or_sidecar";
    package_tree: "package_tree";
    machine_workspace: "machine_workspace";
    non_regular_file: "non_regular_file";
    symlink_escape: "symlink_escape";
}>;
export type AgentHomePortableSkipReason = z.infer<typeof AgentHomePortableSkipReasonSchema>;
export declare function classifyAgentHomePortablePath(category: AgentHomePortableCategory, path: string): {
    outcome: "included";
    normalizedPath: string;
} | {
    outcome: "skipped";
    reasonCode: AgentHomePortableSkipReason;
};
export declare const AgentHomeOperationIdentitySchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"invocation">;
    id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"job">;
    id: z.ZodString;
}, z.core.$strict>], "kind">;
export type AgentHomeOperationIdentity = z.infer<typeof AgentHomeOperationIdentitySchema>;
export declare const AgentHomeExecutorSignedMetaSchema: z.ZodObject<{
    requestId: z.ZodString;
    commandId: z.ZodString;
    signer: z.ZodEnum<{
        cloud_workload: "cloud_workload";
        mac_executor: "mac_executor";
    }>;
    signerKeyId: z.ZodString;
    deviceServiceId: z.ZodString;
    sequence: z.ZodNumber;
    issuedAt: z.ZodNumber;
    expiresAt: z.ZodNumber;
    nonce: z.ZodString;
    signature: z.ZodString;
}, z.core.$strict>;
export declare const AgentHomeMacExecutorKeySchema: z.ZodObject<{
    deviceServiceId: z.ZodString;
    keyEpoch: z.ZodNumber;
    keyId: z.ZodString;
    publicKey: z.ZodString;
    status: z.ZodEnum<{
        active: "active";
        retired: "retired";
    }>;
    activatedAtPlatform: z.ZodNumber;
    retiredAtPlatform: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export declare const AgentHomeMacExecutorKeyRotationSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodEnum<{
            cloud_workload: "cloud_workload";
            mac_executor: "mac_executor";
        }>;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    deviceServiceId: z.ZodString;
    previousKeyId: z.ZodString;
    currentKeyEpoch: z.ZodNumber;
    nextKeyEpoch: z.ZodNumber;
    nextKeyId: z.ZodString;
    nextPublicKey: z.ZodString;
}, z.core.$strict>;
export declare const AgentHomeExecutorLeaseFenceSchema: z.ZodObject<{
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    homeEpoch: z.ZodNumber;
    executorTerm: z.ZodNumber;
    leaseId: z.ZodString;
    leaseExpiresAtPlatform: z.ZodNumber;
}, z.core.$strict>;
export type AgentHomeExecutorLeaseFence = z.infer<typeof AgentHomeExecutorLeaseFenceSchema>;
export declare const AgentHomeAuthorityFenceSchema: z.ZodObject<{
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    homeEpoch: z.ZodNumber;
    executorTerm: z.ZodNumber;
    leaseId: z.ZodString;
    leaseExpiresAtPlatform: z.ZodNumber;
    operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"invocation">;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"job">;
        id: z.ZodString;
    }, z.core.$strict>], "kind">;
}, z.core.$strict>;
export type AgentHomeAuthorityFence = z.infer<typeof AgentHomeAuthorityFenceSchema>;
export declare const AgentHomePlacementMoveSchema: z.ZodObject<{
    moveId: z.ZodString;
    idempotencyKey: z.ZodString;
    intent: z.ZodEnum<{
        manual: "manual";
        automatic_failover: "automatic_failover";
        sleep_handoff: "sleep_handoff";
        go_home_when_idle: "go_home_when_idle";
    }>;
    status: z.ZodEnum<{
        superseded: "superseded";
        draining: "draining";
        committed: "committed";
        requested: "requested";
        ready_to_commit: "ready_to_commit";
        aborted: "aborted";
    }>;
    source: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    target: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    expectedHomeEpoch: z.ZodNumber;
    expectedPlacementRevision: z.ZodNumber;
    requestedAtPlatform: z.ZodNumber;
}, z.core.$strict>;
export type AgentHomePlacementMove = z.infer<typeof AgentHomePlacementMoveSchema>;
export declare const AgentHomePlacementRecordSchema: z.ZodObject<{
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    location: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    homeEpoch: z.ZodNumber;
    placementRevision: z.ZodNumber;
    selectedGeneration: z.ZodNumber;
    rollbackFloorGeneration: z.ZodNumber;
    activeMove: z.ZodNullable<z.ZodObject<{
        moveId: z.ZodString;
        idempotencyKey: z.ZodString;
        intent: z.ZodEnum<{
            manual: "manual";
            automatic_failover: "automatic_failover";
            sleep_handoff: "sleep_handoff";
            go_home_when_idle: "go_home_when_idle";
        }>;
        status: z.ZodEnum<{
            superseded: "superseded";
            draining: "draining";
            committed: "committed";
            requested: "requested";
            ready_to_commit: "ready_to_commit";
            aborted: "aborted";
        }>;
        source: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        target: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        expectedHomeEpoch: z.ZodNumber;
        expectedPlacementRevision: z.ZodNumber;
        requestedAtPlatform: z.ZodNumber;
    }, z.core.$strict>>;
    policyRevision: z.ZodNumber;
}, z.core.$strict>;
export type AgentHomePlacementRecord = z.infer<typeof AgentHomePlacementRecordSchema>;
export declare const AgentHomeExecutorLeaseSchema: z.ZodObject<{
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    location: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    issuedAtPlatform: z.ZodNumber;
    expiresAtPlatform: z.ZodNumber;
    status: z.ZodEnum<{
        revoked: "revoked";
        expired: "expired";
        active: "active";
        draining: "draining";
    }>;
}, z.core.$strict>;
export declare const AgentHomeAutomaticFailoverEvidenceSchema: z.ZodObject<{
    pendingWork: z.ZodObject<{
        eventLedgerIds: z.ZodArray<z.ZodString>;
        occurrenceLedgerIds: z.ZodArray<z.ZodString>;
        observedAtPlatform: z.ZodNumber;
        basis: z.ZodLiteral<"durable_event_and_occurrence_ledgers">;
    }, z.core.$strict>;
    readiness: z.ZodObject<{
        homeEpoch: z.ZodNumber;
        epochCommittedAtPlatform: z.ZodNumber;
        lastReadyAtPlatform: z.ZodNullable<z.ZodNumber>;
        observedAtPlatform: z.ZodNumber;
        reachable: z.ZodLiteral<false>;
        powerState: z.ZodEnum<{
            unknown: "unknown";
            asleep_wakeable: "asleep_wakeable";
            awake: "awake";
            asleep_not_wakeable: "asleep_not_wakeable";
        }>;
        unreachableSincePlatform: z.ZodNumber;
        wakeAttemptedAtPlatform: z.ZodNullable<z.ZodNumber>;
        basis: z.ZodLiteral<"authenticated_agent_service_readiness">;
    }, z.core.$strict>;
}, z.core.$strict>;
export type AgentHomeAutomaticFailoverEvidence = z.infer<typeof AgentHomeAutomaticFailoverEvidenceSchema>;
export declare const AgentHomeMoveRequestSchema: z.ZodUnion<readonly [z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    moveId: z.ZodString;
    idempotencyKey: z.ZodString;
    homeId: z.ZodString;
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    source: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    target: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    expectedHomeEpoch: z.ZodNumber;
    expectedPlacementRevision: z.ZodNumber;
    requestedAtPlatform: z.ZodNumber;
    intent: z.ZodLiteral<"manual">;
    priority: z.ZodLiteral<"manual">;
    trigger: z.ZodLiteral<"owner_request">;
}, z.core.$strict>, z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    moveId: z.ZodString;
    idempotencyKey: z.ZodString;
    homeId: z.ZodString;
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    source: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    target: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    expectedHomeEpoch: z.ZodNumber;
    expectedPlacementRevision: z.ZodNumber;
    requestedAtPlatform: z.ZodNumber;
    intent: z.ZodLiteral<"automatic_failover">;
    priority: z.ZodLiteral<"automatic">;
    trigger: z.ZodLiteral<"pending_unreachable">;
    evidence: z.ZodObject<{
        pendingWork: z.ZodObject<{
            eventLedgerIds: z.ZodArray<z.ZodString>;
            occurrenceLedgerIds: z.ZodArray<z.ZodString>;
            observedAtPlatform: z.ZodNumber;
            basis: z.ZodLiteral<"durable_event_and_occurrence_ledgers">;
        }, z.core.$strict>;
        readiness: z.ZodObject<{
            homeEpoch: z.ZodNumber;
            epochCommittedAtPlatform: z.ZodNumber;
            lastReadyAtPlatform: z.ZodNullable<z.ZodNumber>;
            observedAtPlatform: z.ZodNumber;
            reachable: z.ZodLiteral<false>;
            powerState: z.ZodEnum<{
                unknown: "unknown";
                asleep_wakeable: "asleep_wakeable";
                awake: "awake";
                asleep_not_wakeable: "asleep_not_wakeable";
            }>;
            unreachableSincePlatform: z.ZodNumber;
            wakeAttemptedAtPlatform: z.ZodNullable<z.ZodNumber>;
            basis: z.ZodLiteral<"authenticated_agent_service_readiness">;
        }, z.core.$strict>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    moveId: z.ZodString;
    idempotencyKey: z.ZodString;
    homeId: z.ZodString;
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    source: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    target: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    expectedHomeEpoch: z.ZodNumber;
    expectedPlacementRevision: z.ZodNumber;
    requestedAtPlatform: z.ZodNumber;
    intent: z.ZodLiteral<"go_home_when_idle">;
    priority: z.ZodLiteral<"automatic">;
    trigger: z.ZodLiteral<"idle_return">;
}, z.core.$strict>, z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    moveId: z.ZodString;
    idempotencyKey: z.ZodString;
    homeId: z.ZodString;
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    source: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    target: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    expectedHomeEpoch: z.ZodNumber;
    expectedPlacementRevision: z.ZodNumber;
    requestedAtPlatform: z.ZodNumber;
    intent: z.ZodLiteral<"sleep_handoff">;
    priority: z.ZodLiteral<"best_effort">;
    trigger: z.ZodLiteral<"sleep_signal">;
}, z.core.$strict>]>;
export type AgentHomeAutomaticMoveRequest = Extract<z.infer<typeof AgentHomeMoveRequestSchema>, {
    intent: "automatic_failover";
}>;
export declare const AgentHomeMoveDrainSchema: z.ZodUnion<readonly [z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    moveId: z.ZodString;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"invocation">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"job">;
            id: z.ZodString;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
    deadlineAtPlatform: z.ZodNumber;
    mode: z.ZodLiteral<"ordinary">;
    result: z.ZodEnum<{
        quiesced: "quiesced";
        requested: "requested";
        timed_out: "timed_out";
        unreachable: "unreachable";
    }>;
    fallback: z.ZodLiteral<"none">;
}, z.core.$strict>, z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    moveId: z.ZodString;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"invocation">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"job">;
            id: z.ZodString;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
    deadlineAtPlatform: z.ZodNumber;
    mode: z.ZodLiteral<"best_effort_sleep">;
    result: z.ZodEnum<{
        quiesced: "quiesced";
        requested: "requested";
    }>;
    fallback: z.ZodLiteral<"none">;
}, z.core.$strict>, z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    moveId: z.ZodString;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"invocation">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"job">;
            id: z.ZodString;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
    deadlineAtPlatform: z.ZodNumber;
    mode: z.ZodLiteral<"best_effort_sleep">;
    result: z.ZodEnum<{
        timed_out: "timed_out";
        unreachable: "unreachable";
    }>;
    fallback: z.ZodLiteral<"ordinary_slow_rule">;
}, z.core.$strict>]>;
export declare const AgentHomeMoveCommitSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    moveId: z.ZodString;
    idempotencyKey: z.ZodString;
    source: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    target: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    expectedHomeEpoch: z.ZodNumber;
    nextHomeEpoch: z.ZodNumber;
    expectedPlacementRevision: z.ZodNumber;
    nextPlacementRevision: z.ZodNumber;
    selectedGeneration: z.ZodNumber;
    rollbackFloorGeneration: z.ZodNumber;
    outcome: z.ZodEnum<{
        superseded: "superseded";
        committed: "committed";
        aborted: "aborted";
        already_committed: "already_committed";
        stale_cas: "stale_cas";
    }>;
    committedAtPlatform: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export declare const AgentHomeMoveAbortSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    moveId: z.ZodString;
    idempotencyKey: z.ZodString;
    expectedHomeEpoch: z.ZodNumber;
    expectedPlacementRevision: z.ZodNumber;
    reason: z.ZodEnum<{
        owner_cancelled: "owner_cancelled";
        drain_failed: "drain_failed";
        target_unavailable: "target_unavailable";
        sleep_budget_elapsed: "sleep_budget_elapsed";
    }>;
    outcome: z.ZodEnum<{
        aborted: "aborted";
        stale_cas: "stale_cas";
        already_aborted: "already_aborted";
        committed_epoch_preserved: "committed_epoch_preserved";
    }>;
}, z.core.$strict>;
export declare const AgentHomeMoveSupersedeSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    winningMoveId: z.ZodString;
    supersededMoveId: z.ZodString;
    expectedHomeEpoch: z.ZodNumber;
    expectedPlacementRevision: z.ZodNumber;
    winningIntent: z.ZodLiteral<"manual">;
    supersededIntent: z.ZodEnum<{
        manual: "manual";
        automatic_failover: "automatic_failover";
        sleep_handoff: "sleep_handoff";
        go_home_when_idle: "go_home_when_idle";
    }>;
    outcome: z.ZodEnum<{
        superseded: "superseded";
        committed_epoch_preserved: "committed_epoch_preserved";
        already_superseded: "already_superseded";
    }>;
}, z.core.$strict>;
export declare const AgentHomePortableManifestEntrySchema: z.ZodObject<{
    category: z.ZodEnum<{
        skills: "skills";
        memory: "memory";
        non_secret_config: "non_secret_config";
        routine_definitions: "routine_definitions";
        portable_app_data: "portable_app_data";
    }>;
    path: z.ZodString;
    sha256: z.ZodString;
    bytes: z.ZodNumber;
    stable: z.ZodLiteral<true>;
    fileType: z.ZodLiteral<"regular_file">;
    symlinkTraversal: z.ZodLiteral<"none">;
}, z.core.$strict>;
export declare const AgentHomeCheckpointSkippedPathSchema: z.ZodObject<{
    category: z.ZodEnum<{
        skills: "skills";
        memory: "memory";
        non_secret_config: "non_secret_config";
        routine_definitions: "routine_definitions";
        portable_app_data: "portable_app_data";
    }>;
    reasonCode: z.ZodEnum<{
        invalid_relative_path: "invalid_relative_path";
        outside_category: "outside_category";
        credential_or_key_material: "credential_or_key_material";
        browser_profile: "browser_profile";
        database_or_sidecar: "database_or_sidecar";
        package_tree: "package_tree";
        machine_workspace: "machine_workspace";
        non_regular_file: "non_regular_file";
        symlink_escape: "symlink_escape";
    }>;
    count: z.ZodNumber;
    pathSha256: z.ZodString;
}, z.core.$strict>;
export declare const AgentHomePortableManifestSchema: z.ZodObject<{
    homeId: z.ZodString;
    generation: z.ZodNumber;
    parentGeneration: z.ZodNumber;
    producingHomeEpoch: z.ZodNumber;
    manifestSha256: z.ZodString;
    entries: z.ZodArray<z.ZodObject<{
        category: z.ZodEnum<{
            skills: "skills";
            memory: "memory";
            non_secret_config: "non_secret_config";
            routine_definitions: "routine_definitions";
            portable_app_data: "portable_app_data";
        }>;
        path: z.ZodString;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
        stable: z.ZodLiteral<true>;
        fileType: z.ZodLiteral<"regular_file">;
        symlinkTraversal: z.ZodLiteral<"none">;
    }, z.core.$strict>>;
    encryption: z.ZodObject<{
        encrypted: z.ZodLiteral<true>;
        keyScope: z.ZodLiteral<"owner_agent_home">;
        credentialMaterialIncluded: z.ZodLiteral<false>;
    }, z.core.$strict>;
    contentPolicy: z.ZodObject<{
        memory: z.ZodLiteral<"included">;
        skills: z.ZodLiteral<"included">;
        nonSecretConfig: z.ZodLiteral<"included">;
        routineDefinitions: z.ZodLiteral<"included">;
        portableAppData: z.ZodLiteral<"included">;
        sessionHistoryStateDb: z.ZodLiteral<"excluded">;
        packages: z.ZodLiteral<"excluded">;
        browserSessions: z.ZodLiteral<"excluded">;
        machineWorkspace: z.ZodLiteral<"excluded">;
        credentials: z.ZodLiteral<"excluded_all">;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const AgentHomeCheckpointCaptureSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodEnum<{
            cloud_workload: "cloud_workload";
            mac_executor: "mac_executor";
        }>;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"invocation">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"job">;
            id: z.ZodString;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
    expectedPlacementRevision: z.ZodNumber;
    generation: z.ZodNumber;
    parentGeneration: z.ZodNumber;
    dirty: z.ZodLiteral<true>;
    reason: z.ZodEnum<{
        idle: "idle";
        manual: "manual";
        cadence_dirty: "cadence_dirty";
        move_drain: "move_drain";
    }>;
    manifestSha256: z.ZodString;
    includedFiles: z.ZodNumber;
    skipped: z.ZodArray<z.ZodObject<{
        category: z.ZodEnum<{
            skills: "skills";
            memory: "memory";
            non_secret_config: "non_secret_config";
            routine_definitions: "routine_definitions";
            portable_app_data: "portable_app_data";
        }>;
        reasonCode: z.ZodEnum<{
            invalid_relative_path: "invalid_relative_path";
            outside_category: "outside_category";
            credential_or_key_material: "credential_or_key_material";
            browser_profile: "browser_profile";
            database_or_sidecar: "database_or_sidecar";
            package_tree: "package_tree";
            machine_workspace: "machine_workspace";
            non_regular_file: "non_regular_file";
            symlink_escape: "symlink_escape";
        }>;
        count: z.ZodNumber;
        pathSha256: z.ZodString;
    }, z.core.$strict>>;
    consistency: z.ZodObject<{
        writersQuiesced: z.ZodLiteral<true>;
        sqliteMethod: z.ZodLiteral<"sqlite_backup">;
        stableFilesStaged: z.ZodLiteral<true>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const AgentHomePortableCheckpointCommitSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"invocation">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"job">;
            id: z.ZodString;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
    expectedHomeEpoch: z.ZodNumber;
    expectedPlacementRevision: z.ZodNumber;
    nextPlacementRevision: z.ZodNumber;
    generation: z.ZodNumber;
    selectedGenerationBefore: z.ZodNumber;
    parentGeneration: z.ZodNumber;
    producingHomeEpoch: z.ZodNumber;
    eraseEpoch: z.ZodNumber;
    manifestSha256: z.ZodString;
    uploadVerified: z.ZodBoolean;
    outcome: z.ZodEnum<{
        stale_revision: "stale_revision";
        committed: "committed";
        already_committed: "already_committed";
        stale_epoch: "stale_epoch";
        verification_failed: "verification_failed";
    }>;
}, z.core.$strict>;
export declare const AgentHomeCheckpointResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    checkpointId: z.ZodString;
    outcome: z.ZodLiteral<"committed">;
    generation: z.ZodNumber;
    selectedGeneration: z.ZodNumber;
    placementRevision: z.ZodNumber;
    manifestSha256: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    checkpointId: z.ZodString;
    outcome: z.ZodLiteral<"failed_previous_selected">;
    attemptedGeneration: z.ZodNumber;
    selectedGenerationBefore: z.ZodNumber;
    selectedGenerationAfter: z.ZodNumber;
    placementRevisionBefore: z.ZodNumber;
    placementRevisionAfter: z.ZodNumber;
    reason: z.ZodEnum<{
        stale_epoch: "stale_epoch";
        verification_failed: "verification_failed";
        quiesce_failed: "quiesce_failed";
        sqlite_backup_failed: "sqlite_backup_failed";
        staging_failed: "staging_failed";
        upload_failed: "upload_failed";
    }>;
}, z.core.$strict>]>;
export declare const AgentHomeReadinessReportSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodEnum<{
            cloud_workload: "cloud_workload";
            mac_executor: "mac_executor";
        }>;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    reportedAtLocal: z.ZodNumber;
    powerState: z.ZodEnum<{
        unknown: "unknown";
        asleep_wakeable: "asleep_wakeable";
        awake: "awake";
        asleep_not_wakeable: "asleep_not_wakeable";
    }>;
    checks: z.ZodObject<{
        homeAccessible: z.ZodBoolean;
        runtimeUsable: z.ZodBoolean;
        matrixIntakeWorking: z.ZodBoolean;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const AgentHomeReadinessObservationSchema: z.ZodObject<{
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    homeEpoch: z.ZodNumber;
    receivedAtPlatform: z.ZodNumber;
    lastReadyAtPlatform: z.ZodNullable<z.ZodNumber>;
    reachable: z.ZodBoolean;
    powerState: z.ZodEnum<{
        unknown: "unknown";
        asleep_wakeable: "asleep_wakeable";
        awake: "awake";
        asleep_not_wakeable: "asleep_not_wakeable";
    }>;
    basis: z.ZodLiteral<"authenticated_agent_service_readiness">;
}, z.core.$strict>;
export declare const AgentHomePendingWorkSnapshotSchema: z.ZodObject<{
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    observedAtPlatform: z.ZodNumber;
    eventLedger: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        state: z.ZodEnum<{
            completed: "completed";
            stopped: "stopped";
            uncertain: "uncertain";
            queued: "queued";
            taken: "taken";
            dispatched: "dispatched";
        }>;
    }, z.core.$strict>>;
    occurrenceLedger: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        state: z.ZodEnum<{
            completed: "completed";
            claimed: "claimed";
            stopped: "stopped";
            due: "due";
        }>;
        dueAt: z.ZodNumber;
    }, z.core.$strict>>;
    basis: z.ZodLiteral<"durable_event_and_occurrence_ledgers">;
    visibleReplyStateIgnored: z.ZodLiteral<true>;
}, z.core.$strict>;
export declare const AgentHomePolicySchema: z.ZodObject<{
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    revision: z.ZodNumber;
    backupEnabled: z.ZodBoolean;
    neverRunInCloud: z.ZodBoolean;
    checkpointCadenceMs: z.ZodNumber;
    failoverDelayMs: z.ZodNumber;
    eligibilitySweepMs: z.ZodNumber;
    fallbackOrder: z.ZodArray<z.ZodObject<{
        destination: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        enabled: z.ZodBoolean;
    }, z.core.$strict>>;
    returnMode: z.ZodEnum<{
        stay_put: "stay_put";
        go_home_when_idle: "go_home_when_idle";
    }>;
}, z.core.$strict>;
export type AgentHomePolicy = z.infer<typeof AgentHomePolicySchema>;
export declare const AgentHomeProtectedOperationSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        checkpoint: "checkpoint";
        work_admission: "work_admission";
        connector_effect: "connector_effect";
        device_effect: "device_effect";
        matrix_publication: "matrix_publication";
    }>;
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodEnum<{
            cloud_workload: "cloud_workload";
            mac_executor: "mac_executor";
        }>;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"invocation">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"job">;
            id: z.ZodString;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
    placement: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    requestedAtPlatform: z.ZodNumber;
}, z.core.$strict>;
declare const AuthorityAcceptedSchema: z.ZodObject<{
    outcome: z.ZodLiteral<"accepted">;
    reason: z.ZodLiteral<"current_authority">;
}, z.core.$strict>;
declare const AuthorityRefusedSchema: z.ZodObject<{
    outcome: z.ZodLiteral<"refused">;
    reason: z.ZodEnum<{
        wrong_owner: "wrong_owner";
        wrong_agent: "wrong_agent";
        bad_signature: "bad_signature";
        lease_expired: "lease_expired";
        wrong_home: "wrong_home";
        stale_home_epoch: "stale_home_epoch";
        stale_executor_term: "stale_executor_term";
        wrong_operation: "wrong_operation";
        wrong_lease: "wrong_lease";
        wrong_signer_location: "wrong_signer_location";
        unpinned_signer_key: "unpinned_signer_key";
        signature_expired: "signature_expired";
    }>;
}, z.core.$strict>;
export declare const AgentHomeAuthorityCaseSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        checkpoint: "checkpoint";
        work_admission: "work_admission";
        connector_effect: "connector_effect";
        device_effect: "device_effect";
        matrix_publication: "matrix_publication";
    }>;
    presented: z.ZodObject<{
        meta: z.ZodObject<{
            requestId: z.ZodString;
            commandId: z.ZodString;
            signer: z.ZodEnum<{
                cloud_workload: "cloud_workload";
                mac_executor: "mac_executor";
            }>;
            signerKeyId: z.ZodString;
            deviceServiceId: z.ZodString;
            sequence: z.ZodNumber;
            issuedAt: z.ZodNumber;
            expiresAt: z.ZodNumber;
            nonce: z.ZodString;
            signature: z.ZodString;
        }, z.core.$strict>;
        fence: z.ZodObject<{
            ownerUserId: z.ZodString;
            agentPrincipal: z.ZodString;
            homeId: z.ZodString;
            homeEpoch: z.ZodNumber;
            executorTerm: z.ZodNumber;
            leaseId: z.ZodString;
            leaseExpiresAtPlatform: z.ZodNumber;
            operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"invocation">;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"job">;
                id: z.ZodString;
            }, z.core.$strict>], "kind">;
        }, z.core.$strict>;
    }, z.core.$strict>;
    trusted: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"invocation">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"job">;
            id: z.ZodString;
        }, z.core.$strict>], "kind">;
        placement: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        pinnedSignerKeyId: z.ZodString;
        signatureValid: z.ZodBoolean;
        nowPlatform: z.ZodNumber;
    }, z.core.$strict>;
    expect: z.ZodUnion<readonly [z.ZodObject<{
        outcome: z.ZodLiteral<"accepted">;
        reason: z.ZodLiteral<"current_authority">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"refused">;
        reason: z.ZodEnum<{
            wrong_owner: "wrong_owner";
            wrong_agent: "wrong_agent";
            bad_signature: "bad_signature";
            lease_expired: "lease_expired";
            wrong_home: "wrong_home";
            stale_home_epoch: "stale_home_epoch";
            stale_executor_term: "stale_executor_term";
            wrong_operation: "wrong_operation";
            wrong_lease: "wrong_lease";
            wrong_signer_location: "wrong_signer_location";
            unpinned_signer_key: "unpinned_signer_key";
            signature_expired: "signature_expired";
        }>;
    }, z.core.$strict>]>;
}, z.core.$strict>;
export declare const MatrixHomePublicationEnqueueSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodEnum<{
            cloud_workload: "cloud_workload";
            mac_executor: "mac_executor";
        }>;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"invocation">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"job">;
            id: z.ZodString;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
    expectedPlacementRevision: z.ZodNumber;
    moveSerializationRevision: z.ZodNumber;
    outboxId: z.ZodString;
    roomId: z.ZodString;
    transactionId: z.ZodString;
    payloadSha256: z.ZodString;
}, z.core.$strict>;
export declare const MatrixHomePublicationReceiptSchema: z.ZodObject<{
    outboxId: z.ZodString;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"invocation">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"job">;
            id: z.ZodString;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
    moveSerializationRevision: z.ZodNumber;
    state: z.ZodEnum<{
        uncertain: "uncertain";
        queued: "queued";
        published: "published";
        refused: "refused";
        admitted: "admitted";
        sending: "sending";
    }>;
    eventId: z.ZodNullable<z.ZodString>;
    reason: z.ZodNullable<z.ZodEnum<{
        effect_unknown: "effect_unknown";
        stale_authority: "stale_authority";
        move_in_progress: "move_in_progress";
        matrix_error: "matrix_error";
    }>>;
}, z.core.$strict>;
export declare const AgentHomeUnledgeredPublicationKindSchema: z.ZodEnum<{
    notice: "notice";
    routine_result: "routine_result";
    group_notice: "group_notice";
    task_event: "task_event";
    task_file: "task_file";
}>;
export type AgentHomeUnledgeredPublicationKind = z.infer<typeof AgentHomeUnledgeredPublicationKindSchema>;
export declare const MatrixHomeUnledgeredPublicationEnqueueSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodEnum<{
            cloud_workload: "cloud_workload";
            mac_executor: "mac_executor";
        }>;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    expectedPlacementRevision: z.ZodNumber;
    moveSerializationRevision: z.ZodNumber;
    outboxId: z.ZodString;
    publicationKind: z.ZodEnum<{
        notice: "notice";
        routine_result: "routine_result";
        group_notice: "group_notice";
        task_event: "task_event";
        task_file: "task_file";
    }>;
    clientKey: z.ZodString;
    roomId: z.ZodString;
    transactionId: z.ZodString;
    payloadSha256: z.ZodString;
    payloadBytes: z.ZodNumber;
}, z.core.$strict>;
export type MatrixHomeUnledgeredPublicationEnqueue = z.infer<typeof MatrixHomeUnledgeredPublicationEnqueueSchema>;
export declare const MatrixHomeUnledgeredPublicationReceiptSchema: z.ZodObject<{
    outboxId: z.ZodString;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    publicationKind: z.ZodEnum<{
        notice: "notice";
        routine_result: "routine_result";
        group_notice: "group_notice";
        task_event: "task_event";
        task_file: "task_file";
    }>;
    clientKey: z.ZodString;
    moveSerializationRevision: z.ZodNumber;
    state: z.ZodEnum<{
        uncertain: "uncertain";
        queued: "queued";
        published: "published";
        refused: "refused";
        admitted: "admitted";
        sending: "sending";
    }>;
    eventId: z.ZodNullable<z.ZodString>;
    reason: z.ZodNullable<z.ZodEnum<{
        effect_unknown: "effect_unknown";
        stale_authority: "stale_authority";
        move_in_progress: "move_in_progress";
        matrix_error: "matrix_error";
    }>>;
}, z.core.$strict>;
export declare function decideAgentHomeUnledgeredPublicationReplay(stored: MatrixHomeUnledgeredPublicationEnqueue, replay: MatrixHomeUnledgeredPublicationEnqueue): {
    outcome: "exact_replay" | "idempotency_conflict";
};
export interface AgentHomeUnledgeredPublicationKeyRecord {
    homeEpoch: number;
    state: "queued" | "admitted" | "sending" | "published" | "refused" | "uncertain" | "partial";
    eventId: string | null;
}
export declare function decideAgentHomeUnledgeredPublicationKeyReuse(prior: AgentHomeUnledgeredPublicationKeyRecord, currentHomeEpoch: number): {
    outcome: "supersede_refused" | "retain_key";
};
export declare const AgentHomeReturnReportSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodEnum<{
            cloud_workload: "cloud_workload";
            mac_executor: "mac_executor";
        }>;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    location: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    sourceHomeEpoch: z.ZodNumber;
    eraseEpoch: z.ZodNumber;
    observedPlacementRevision: z.ZodNumber;
    observedMoveId: z.ZodNullable<z.ZodString>;
    baseGeneration: z.ZodNumber;
    sourceManifestSha256: z.ZodString;
    currentManifestSha256: z.ZodString;
    divergent: z.ZodLiteral<true>;
}, z.core.$strict>;
export declare const AgentHomeConflictQuarantineSchema: z.ZodObject<{
    quarantineId: z.ZodString;
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    sourceLocation: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    sourceHomeEpoch: z.ZodNumber;
    baseGeneration: z.ZodNumber;
    sourceManifestSha256: z.ZodString;
    currentManifestSha256: z.ZodString;
    status: z.ZodLiteral<"quarantined">;
    autoPromoted: z.ZodLiteral<false>;
    autoMerged: z.ZodLiteral<false>;
    sessionHistoryIncluded: z.ZodLiteral<false>;
}, z.core.$strict>;
export declare const AgentHomeConflictImportSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    fence: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        homeEpoch: z.ZodNumber;
        executorTerm: z.ZodNumber;
        leaseId: z.ZodString;
        leaseExpiresAtPlatform: z.ZodNumber;
        operation: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"invocation">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"job">;
            id: z.ZodString;
        }, z.core.$strict>], "kind">;
    }, z.core.$strict>;
    quarantineId: z.ZodString;
    reviewId: z.ZodString;
    reviewedBy: z.ZodString;
    eraseEpoch: z.ZodNumber;
    expectedHomeEpoch: z.ZodNumber;
    expectedPlacementRevision: z.ZodNumber;
    nextPlacementRevision: z.ZodNumber;
    parentGeneration: z.ZodNumber;
    generation: z.ZodNumber;
    sourceManifestSha256: z.ZodString;
    outcome: z.ZodEnum<{
        refused: "refused";
        imported: "imported";
        stale_cas: "stale_cas";
    }>;
}, z.core.$strict>;
export declare const AgentHomeEraseFenceSchema: z.ZodObject<{
    erasureId: z.ZodString;
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    eraseEpoch: z.ZodNumber;
    issuedAtPlatform: z.ZodNumber;
    expiresAtPlatform: z.ZodNumber;
}, z.core.$strict>;
export type AgentHomeEraseFence = z.infer<typeof AgentHomeEraseFenceSchema>;
export declare const AgentHomeEraseRequestSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodLiteral<"platform_controller">;
        signerKeyId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    eraseFence: z.ZodObject<{
        erasureId: z.ZodString;
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        eraseEpoch: z.ZodNumber;
        issuedAtPlatform: z.ZodNumber;
        expiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    expectedPlacementRevision: z.ZodNumber;
    eraseEpoch: z.ZodNumber;
    locations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">>;
    scopes: z.ZodObject<{
        workingHome: z.ZodLiteral<true>;
        checkpoints: z.ZodLiteral<true>;
        snapshots: z.ZodLiteral<true>;
        quarantinedConflicts: z.ZodLiteral<true>;
        credentials: z.ZodLiteral<true>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const AgentHomeEraseReceiptSchema: z.ZodObject<{
    meta: z.ZodObject<{
        requestId: z.ZodString;
        commandId: z.ZodString;
        signer: z.ZodEnum<{
            cloud_workload: "cloud_workload";
            mac_executor: "mac_executor";
        }>;
        signerKeyId: z.ZodString;
        deviceServiceId: z.ZodString;
        sequence: z.ZodNumber;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        nonce: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strict>;
    eraseFence: z.ZodObject<{
        erasureId: z.ZodString;
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        eraseEpoch: z.ZodNumber;
        issuedAtPlatform: z.ZodNumber;
        expiresAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    eraseEpoch: z.ZodNumber;
    outcome: z.ZodEnum<{
        complete: "complete";
        pending_offline: "pending_offline";
    }>;
    requestedLocations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">>;
    coveredLocations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">>;
    locations: z.ZodArray<z.ZodObject<{
        location: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        state: z.ZodEnum<{
            erased: "erased";
            pending_offline: "pending_offline";
        }>;
    }, z.core.$strict>>;
    resurrection: z.ZodLiteral<"forbidden">;
    tombstoneDurable: z.ZodLiteral<true>;
}, z.core.$strict>;
export declare const AgentHomeEraseTombstoneSchema: z.ZodObject<{
    erasureId: z.ZodString;
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    eraseEpoch: z.ZodNumber;
    requestedLocations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">>;
    erasedLocations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">>;
    status: z.ZodEnum<{
        complete: "complete";
        pending_offline: "pending_offline";
    }>;
    committedAtPlatform: z.ZodNumber;
}, z.core.$strict>;
export type AgentHomeEraseTombstone = z.infer<typeof AgentHomeEraseTombstoneSchema>;
export declare const AgentHomeRestoreRequestSchema: z.ZodObject<{
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    sourceGeneration: z.ZodNumber;
    observedEraseEpoch: z.ZodNumber;
}, z.core.$strict>;
export type AgentHomeRestoreRequest = z.infer<typeof AgentHomeRestoreRequestSchema>;
export declare const AgentHomePortableRestoreRecordSchema: z.ZodObject<{
    ownerUserId: z.ZodString;
    agentPrincipal: z.ZodString;
    homeId: z.ZodString;
    sourceGeneration: z.ZodNumber;
    checkedEraseEpoch: z.ZodNumber;
    browserSessionsOnRestore: z.ZodLiteral<"excluded">;
    freshBrowserSignInRequired: z.ZodLiteral<true>;
}, z.core.$strict>;
export declare const AgentHomeMoveArbitrationCaseSchema: z.ZodObject<{
    current: z.ZodObject<{
        moveId: z.ZodString;
        idempotencyKey: z.ZodString;
        intent: z.ZodEnum<{
            manual: "manual";
            automatic_failover: "automatic_failover";
            sleep_handoff: "sleep_handoff";
            go_home_when_idle: "go_home_when_idle";
        }>;
        status: z.ZodEnum<{
            superseded: "superseded";
            draining: "draining";
            committed: "committed";
            requested: "requested";
            ready_to_commit: "ready_to_commit";
            aborted: "aborted";
        }>;
        source: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        target: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        expectedHomeEpoch: z.ZodNumber;
        expectedPlacementRevision: z.ZodNumber;
        requestedAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    incoming: z.ZodObject<{
        moveId: z.ZodString;
        idempotencyKey: z.ZodString;
        intent: z.ZodEnum<{
            manual: "manual";
            automatic_failover: "automatic_failover";
            sleep_handoff: "sleep_handoff";
            go_home_when_idle: "go_home_when_idle";
        }>;
        status: z.ZodEnum<{
            superseded: "superseded";
            draining: "draining";
            committed: "committed";
            requested: "requested";
            ready_to_commit: "ready_to_commit";
            aborted: "aborted";
        }>;
        source: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        target: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        expectedHomeEpoch: z.ZodNumber;
        expectedPlacementRevision: z.ZodNumber;
        requestedAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    expect: z.ZodUnion<readonly [z.ZodObject<{
        outcome: z.ZodLiteral<"replay">;
        reason: z.ZodEnum<{
            same_intent: "same_intent";
            already_committed_exact_epoch: "already_committed_exact_epoch";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"fresh">;
        reason: z.ZodEnum<{
            terminal_move_replaced: "terminal_move_replaced";
            committed_history_advanced: "committed_history_advanced";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"supersede">;
        reason: z.ZodEnum<{
            manual_beats_uncommitted_automation: "manual_beats_uncommitted_automation";
            manual_retargets_uncommitted_manual: "manual_retargets_uncommitted_manual";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"refused">;
        reason: z.ZodEnum<{
            idempotency_conflict: "idempotency_conflict";
            committed_epoch_preserved: "committed_epoch_preserved";
            committed_epoch_mismatch: "committed_epoch_mismatch";
            automatic_cannot_supersede: "automatic_cannot_supersede";
        }>;
    }, z.core.$strict>]>;
}, z.core.$strict>;
export declare const AgentHomeFailoverCaseSchema: z.ZodObject<{
    nowPlatform: z.ZodNumber;
    lastReadyAtPlatform: z.ZodNullable<z.ZodNumber>;
    epochCommittedAtPlatform: z.ZodNumber;
    localClock: z.ZodNumber;
    pendingEvents: z.ZodNumber;
    dueOccurrences: z.ZodNumber;
    homeReachable: z.ZodBoolean;
    homePowerState: z.ZodEnum<{
        unknown: "unknown";
        asleep_wakeable: "asleep_wakeable";
        awake: "awake";
        asleep_not_wakeable: "asleep_not_wakeable";
    }>;
    unreachableSincePlatform: z.ZodNumber;
    wakeAttemptedAtPlatform: z.ZodNullable<z.ZodNumber>;
    currentLocation: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    policy: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        revision: z.ZodNumber;
        backupEnabled: z.ZodBoolean;
        neverRunInCloud: z.ZodBoolean;
        checkpointCadenceMs: z.ZodNumber;
        failoverDelayMs: z.ZodNumber;
        eligibilitySweepMs: z.ZodNumber;
        fallbackOrder: z.ZodArray<z.ZodObject<{
            destination: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"cloud">;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"mac">;
                deviceServiceId: z.ZodString;
            }, z.core.$strict>], "kind">;
            enabled: z.ZodBoolean;
        }, z.core.$strict>>;
        returnMode: z.ZodEnum<{
            stay_put: "stay_put";
            go_home_when_idle: "go_home_when_idle";
        }>;
    }, z.core.$strict>;
    availableDestinations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">>;
    expect: z.ZodUnion<readonly [z.ZodObject<{
        outcome: z.ZodLiteral<"move">;
        target: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        reason: z.ZodLiteral<"pending_and_unreachable">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"wake">;
        reason: z.ZodLiteral<"asleep_wakeable">;
        graceUntilPlatform: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"stay">;
        reason: z.ZodEnum<{
            no_pending_work: "no_pending_work";
            failover_delay_not_elapsed: "failover_delay_not_elapsed";
            home_ready: "home_ready";
            wake_grace_not_elapsed: "wake_grace_not_elapsed";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"unavailable">;
        reason: z.ZodEnum<{
            no_enabled_destination: "no_enabled_destination";
            strictly_local_home_lost: "strictly_local_home_lost";
            state_unrecoverable_without_backup: "state_unrecoverable_without_backup";
        }>;
    }, z.core.$strict>]>;
}, z.core.$strict>;
export type AgentHomeFailoverCase = z.infer<typeof AgentHomeFailoverCaseSchema>;
export declare const AgentHomeIdleReturnCaseSchema: z.ZodObject<{
    idle: z.ZodBoolean;
    currentLocation: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    preferredHome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"cloud">;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mac">;
        deviceServiceId: z.ZodString;
    }, z.core.$strict>], "kind">;
    policy: z.ZodObject<{
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        revision: z.ZodNumber;
        backupEnabled: z.ZodBoolean;
        neverRunInCloud: z.ZodBoolean;
        checkpointCadenceMs: z.ZodNumber;
        failoverDelayMs: z.ZodNumber;
        eligibilitySweepMs: z.ZodNumber;
        fallbackOrder: z.ZodArray<z.ZodObject<{
            destination: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"cloud">;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"mac">;
                deviceServiceId: z.ZodString;
            }, z.core.$strict>], "kind">;
            enabled: z.ZodBoolean;
        }, z.core.$strict>>;
        returnMode: z.ZodEnum<{
            stay_put: "stay_put";
            go_home_when_idle: "go_home_when_idle";
        }>;
    }, z.core.$strict>;
    expect: z.ZodUnion<readonly [z.ZodObject<{
        outcome: z.ZodLiteral<"move">;
        target: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">;
        reason: z.ZodLiteral<"idle_return_enabled">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"refused">;
        reason: z.ZodLiteral<"stay_put_policy">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"stay">;
        reason: z.ZodEnum<{
            not_idle: "not_idle";
            already_home: "already_home";
        }>;
    }, z.core.$strict>]>;
}, z.core.$strict>;
export declare const AgentHomeEraseReceiptCaseSchema: z.ZodObject<{
    request: z.ZodObject<{
        meta: z.ZodObject<{
            requestId: z.ZodString;
            commandId: z.ZodString;
            signer: z.ZodLiteral<"platform_controller">;
            signerKeyId: z.ZodString;
            sequence: z.ZodNumber;
            issuedAt: z.ZodNumber;
            expiresAt: z.ZodNumber;
            nonce: z.ZodString;
            signature: z.ZodString;
        }, z.core.$strict>;
        eraseFence: z.ZodObject<{
            erasureId: z.ZodString;
            ownerUserId: z.ZodString;
            agentPrincipal: z.ZodString;
            homeId: z.ZodString;
            eraseEpoch: z.ZodNumber;
            issuedAtPlatform: z.ZodNumber;
            expiresAtPlatform: z.ZodNumber;
        }, z.core.$strict>;
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        expectedPlacementRevision: z.ZodNumber;
        eraseEpoch: z.ZodNumber;
        locations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">>;
        scopes: z.ZodObject<{
            workingHome: z.ZodLiteral<true>;
            checkpoints: z.ZodLiteral<true>;
            snapshots: z.ZodLiteral<true>;
            quarantinedConflicts: z.ZodLiteral<true>;
            credentials: z.ZodLiteral<true>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    receipt: z.ZodObject<{
        meta: z.ZodObject<{
            requestId: z.ZodString;
            commandId: z.ZodString;
            signer: z.ZodEnum<{
                cloud_workload: "cloud_workload";
                mac_executor: "mac_executor";
            }>;
            signerKeyId: z.ZodString;
            deviceServiceId: z.ZodString;
            sequence: z.ZodNumber;
            issuedAt: z.ZodNumber;
            expiresAt: z.ZodNumber;
            nonce: z.ZodString;
            signature: z.ZodString;
        }, z.core.$strict>;
        eraseFence: z.ZodObject<{
            erasureId: z.ZodString;
            ownerUserId: z.ZodString;
            agentPrincipal: z.ZodString;
            homeId: z.ZodString;
            eraseEpoch: z.ZodNumber;
            issuedAtPlatform: z.ZodNumber;
            expiresAtPlatform: z.ZodNumber;
        }, z.core.$strict>;
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        eraseEpoch: z.ZodNumber;
        outcome: z.ZodEnum<{
            complete: "complete";
            pending_offline: "pending_offline";
        }>;
        requestedLocations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">>;
        coveredLocations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">>;
        locations: z.ZodArray<z.ZodObject<{
            location: z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"cloud">;
            }, z.core.$strict>, z.ZodObject<{
                kind: z.ZodLiteral<"mac">;
                deviceServiceId: z.ZodString;
            }, z.core.$strict>], "kind">;
            state: z.ZodEnum<{
                erased: "erased";
                pending_offline: "pending_offline";
            }>;
        }, z.core.$strict>>;
        resurrection: z.ZodLiteral<"forbidden">;
        tombstoneDurable: z.ZodLiteral<true>;
    }, z.core.$strict>;
    expect: z.ZodUnion<readonly [z.ZodObject<{
        outcome: z.ZodLiteral<"accepted">;
        reason: z.ZodLiteral<"erase_fence_and_locations_match">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"refused">;
        reason: z.ZodEnum<{
            erase_fence_mismatch: "erase_fence_mismatch";
            incomplete_location_coverage: "incomplete_location_coverage";
        }>;
    }, z.core.$strict>]>;
}, z.core.$strict>;
export declare const AgentHomePostEraseCaseSchema: z.ZodObject<{
    tombstone: z.ZodObject<{
        erasureId: z.ZodString;
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        eraseEpoch: z.ZodNumber;
        requestedLocations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">>;
        erasedLocations: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"cloud">;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"mac">;
            deviceServiceId: z.ZodString;
        }, z.core.$strict>], "kind">>;
        status: z.ZodEnum<{
            complete: "complete";
            pending_offline: "pending_offline";
        }>;
        committedAtPlatform: z.ZodNumber;
    }, z.core.$strict>;
    operation: z.ZodObject<{
        kind: z.ZodEnum<{
            checkpoint_commit: "checkpoint_commit";
            conflict_import: "conflict_import";
            return_report: "return_report";
        }>;
        ownerUserId: z.ZodString;
        agentPrincipal: z.ZodString;
        homeId: z.ZodString;
        eraseEpoch: z.ZodNumber;
    }, z.core.$strict>;
    expect: z.ZodUnion<readonly [z.ZodObject<{
        outcome: z.ZodLiteral<"accepted">;
        reason: z.ZodLiteral<"different_home">;
    }, z.core.$strict>, z.ZodObject<{
        outcome: z.ZodLiteral<"refused">;
        reason: z.ZodLiteral<"erase_tombstone_fence">;
    }, z.core.$strict>]>;
}, z.core.$strict>;
export declare function decideAgentHomeAuthorityAdmission(presented: z.infer<typeof AgentHomeAuthorityCaseSchema>["presented"], trusted: z.infer<typeof AgentHomeAuthorityCaseSchema>["trusted"]): z.infer<typeof AuthorityAcceptedSchema> | z.infer<typeof AuthorityRefusedSchema>;
export declare function decideAgentHomeMoveArbitration(current: AgentHomePlacementMove, incoming: AgentHomePlacementMove): z.infer<typeof AgentHomeMoveArbitrationCaseSchema>["expect"];
export declare function decideAgentHomeFailover(input: Omit<AgentHomeFailoverCase, "expect">): AgentHomeFailoverCase["expect"];
export declare function decidePortableCheckpointCommit(proposed: {
    uploadVerified: boolean;
    expectedHomeEpoch: number;
    expectedPlacementRevision: number;
    parentGeneration: number;
    generation: number;
}, current: {
    homeEpoch: number;
    placementRevision: number;
    selectedGeneration: number;
}): {
    outcome: "committed";
    nextPlacementRevision: number;
} | {
    outcome: "refused";
    reason: "verification_failed" | "stale_epoch" | "stale_revision" | "invalid_generation";
};
export declare function hasAgentHomePendingWork(snapshot: z.infer<typeof AgentHomePendingWorkSnapshotSchema>): boolean;
export declare function decideAgentHomeAutomaticMoveRequest(request: AgentHomeAutomaticMoveRequest, nowPlatform: number, failoverDelayMs: number, eligibilitySweepMs?: number): {
    outcome: "accepted";
    reason: "pending_and_unreachable_evidence";
} | {
    outcome: "wake";
    reason: "asleep_wakeable";
    graceUntilPlatform: number;
} | {
    outcome: "refused";
    reason: "missing_pending_work_evidence" | "home_ready" | "stale_home_epoch" | "failover_delay_not_elapsed" | "wake_grace_not_elapsed";
};
export declare function decideAgentHomeIdleReturn(input: Omit<z.infer<typeof AgentHomeIdleReturnCaseSchema>, "expect">): z.infer<typeof AgentHomeIdleReturnCaseSchema>["expect"];
export declare function decideAgentHomeEraseReceipt(request: z.infer<typeof AgentHomeEraseRequestSchema>, receipt: z.infer<typeof AgentHomeEraseReceiptSchema>): z.infer<typeof AgentHomeEraseReceiptCaseSchema>["expect"];
export declare function decideAgentHomePostEraseAdmission(tombstone: AgentHomeEraseTombstone, operation: z.infer<typeof AgentHomePostEraseCaseSchema>["operation"]): z.infer<typeof AgentHomePostEraseCaseSchema>["expect"];
export declare function decideAgentHomeRestore(tombstone: AgentHomeEraseTombstone | null, request: AgentHomeRestoreRequest): {
    outcome: "accepted";
    browserSessionsOnRestore: "excluded";
} | {
    outcome: "refused";
    reason: "erased_home_cannot_resurrect";
};
export {};
//# sourceMappingURL=agent-home-placement.d.ts.map