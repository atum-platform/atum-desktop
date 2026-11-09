import { z } from "zod";
import { canonicalJson } from "./host-fs.js";
export const AGENT_HOME_PLACEMENT_PROFILE = "atum.agent-home/2.1";
export const AGENT_HOME_UNLEDGERED_PUBLICATION_PROFILE = "atum.agent-home/2.3";
export const AGENT_HOME_UNLEDGERED_PUBLICATION_KINDS = [
    "notice", "routine_result", "group_notice", "task_event", "task_file",
];
export const AGENT_HOME_UNLEDGERED_PUBLICATION_MAX_PAYLOAD_BYTES = 131_072;
export const AGENT_HOME_UNLEDGERED_PUBLICATION_MAX_CLIENT_KEY_BYTES = 255;
export const AGENT_HOME_DEFAULT_CHECKPOINT_CADENCE_MS = 900_000;
export const AGENT_HOME_DEFAULT_FAILOVER_DELAY_MS = 900_000;
export const AGENT_HOME_DEFAULT_ELIGIBILITY_SWEEP_MS = 60_000;
export const AGENT_HOME_DEFAULT_BACKUP_ENABLED = true;
export const AGENT_HOME_DEFAULT_RETURN_MODE = "stay_put";
const safePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const safeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestampSchema = safeNonnegativeIntegerSchema;
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const b64uSha256Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);
const userIdSchema = z.string().min(4).max(1024).regex(/^@[!-9;-~]+:[!-~]+$/u);
const roomIdSchema = z.string().min(2).max(1024).regex(/^![!-~]+$/u);
const eventIdSchema = z.string().min(2).max(1024).regex(/^\$[!-~]+$/u);
const spkiP256Schema = z.string().regex(/^[A-Za-z0-9_-]{122}$/u);
const SIGNED_MESSAGE_MAX_MS = 7_200_000;
function checkSignedLifetime(meta, context) {
    if (meta.expiresAt <= meta.issuedAt) {
        context.addIssue({ code: "custom", path: ["meta", "expiresAt"], message: "signed message expiry must follow issue time" });
    }
    if (meta.expiresAt > meta.issuedAt + SIGNED_MESSAGE_MAX_MS) {
        context.addIssue({ code: "custom", path: ["meta", "expiresAt"], message: "signed message lifetime exceeds two hours" });
    }
}
const PlatformSignedMetaSchema = z.object({
    requestId: uuidSchema,
    commandId: uuidSchema,
    signer: z.literal("platform_controller"),
    signerKeyId: b64uSha256Schema,
    sequence: safePositiveIntegerSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    nonce: b64uSha256Schema,
    signature: signatureSchema,
}).strict();
export const AgentHomeLocationSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cloud") }).strict(),
    z.object({ kind: z.literal("mac"), deviceServiceId: uuidSchema }).strict(),
]);
function sameLocation(left, right) {
    return left.kind === right.kind && (left.kind === "cloud" || left.deviceServiceId === right.deviceServiceId);
}
const PORTABLE_PATH_ROOTS = {
    memory: "memory/",
    skills: "skills/",
    non_secret_config: "config/",
    routine_definitions: "routines/",
    portable_app_data: "apps/portable/",
};
export const AgentHomePortableCategorySchema = z.enum(["memory", "skills", "non_secret_config", "routine_definitions", "portable_app_data"]);
export const AgentHomePortableSkipReasonSchema = z.enum([
    "invalid_relative_path",
    "outside_category",
    "credential_or_key_material",
    "browser_profile",
    "database_or_sidecar",
    "package_tree",
    "machine_workspace",
    "non_regular_file",
    "symlink_escape",
]);
const PORTABLE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const PORTABLE_PACKAGE_DIRECTORIES = new Set(["node_modules", "site-packages", "venv", ".venv", "package", "packages"]);
const PORTABLE_BROWSER_DIRECTORIES = new Set(["browser", "browsers", "chrome", "chromium", "firefox", "safari", "user data", ".mozilla", "google-chrome", "default"]);
const PORTABLE_CREDENTIAL_DIRECTORIES = new Set([".ssh", ".gnupg", ".aws", ".kube"]);
function portableFileSkipReason(fileName) {
    const name = fileName.toLocaleLowerCase("en-US");
    if (name.startsWith("cookies") || name.startsWith("login data") || name === "local state" || name.startsWith("web data"))
        return "browser_profile";
    if (name === "auth.json" || (name.startsWith("credentials") && name.endsWith(".json"))
        || name.startsWith(".env") || [".netrc", ".npmrc", ".pypirc", ".git-credentials"].includes(name)
        || name.includes(".keychain") || name.startsWith("id_rsa") || name.startsWith("id_ed25519") || name.startsWith("id_ecdsa")
        || [".pem", ".key", ".p12", ".pfx"].some((suffix) => name.endsWith(suffix)))
        return "credential_or_key_material";
    if (name.endsWith(".db") || name.includes(".sqlite") || name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal"))
        return "database_or_sidecar";
    return null;
}
export function classifyAgentHomePortablePath(category, path) {
    if (path !== path.normalize("NFC") || path.startsWith("/") || path.includes("\\") || PORTABLE_CONTROL_CHARACTERS.test(path)) {
        return { outcome: "skipped", reasonCode: "invalid_relative_path" };
    }
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".."))
        return { outcome: "skipped", reasonCode: "invalid_relative_path" };
    const rootParts = PORTABLE_PATH_ROOTS[category].slice(0, -1).split("/");
    if (parts.length <= rootParts.length || rootParts.some((part, index) => parts[index] !== part)) {
        return { outcome: "skipped", reasonCode: "outside_category" };
    }
    const lowerParts = parts.map((part) => part.toLocaleLowerCase("en-US"));
    if (lowerParts.some((part) => PORTABLE_PACKAGE_DIRECTORIES.has(part)))
        return { outcome: "skipped", reasonCode: "package_tree" };
    if (lowerParts.some((part) => part === "workspace"))
        return { outcome: "skipped", reasonCode: "machine_workspace" };
    if (lowerParts.some((part) => PORTABLE_BROWSER_DIRECTORIES.has(part) || part.startsWith("profile ")))
        return { outcome: "skipped", reasonCode: "browser_profile" };
    if (lowerParts.some((part) => PORTABLE_CREDENTIAL_DIRECTORIES.has(part))
        || lowerParts.some((part, index) => part === ".config" && lowerParts[index + 1] === "gcloud")) {
        return { outcome: "skipped", reasonCode: "credential_or_key_material" };
    }
    const fileReason = portableFileSkipReason(parts.at(-1));
    return fileReason === null ? { outcome: "included", normalizedPath: path } : { outcome: "skipped", reasonCode: fileReason };
}
function isClosedPortablePath(category, path) {
    return classifyAgentHomePortablePath(category, path).outcome === "included";
}
export const AgentHomeOperationIdentitySchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("invocation"), id: uuidSchema }).strict(),
    z.object({ kind: z.literal("job"), id: uuidSchema }).strict(),
]);
export const AgentHomeExecutorSignedMetaSchema = z.object({
    requestId: uuidSchema,
    commandId: uuidSchema,
    signer: z.enum(["cloud_workload", "mac_executor"]),
    signerKeyId: b64uSha256Schema,
    deviceServiceId: uuidSchema,
    sequence: safePositiveIntegerSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    nonce: b64uSha256Schema,
    signature: signatureSchema,
}).strict();
export const AgentHomeMacExecutorKeySchema = z.object({
    deviceServiceId: uuidSchema,
    keyEpoch: safePositiveIntegerSchema,
    keyId: b64uSha256Schema,
    publicKey: spkiP256Schema,
    status: z.enum(["active", "retired"]),
    activatedAtPlatform: timestampSchema,
    retiredAtPlatform: timestampSchema.nullable(),
}).strict().superRefine((value, context) => {
    if (value.status === "active" && value.retiredAtPlatform !== null)
        context.addIssue({ code: "custom", path: ["retiredAtPlatform"], message: "active executor key is not retired" });
    if (value.status === "retired" && (value.retiredAtPlatform === null || value.retiredAtPlatform < value.activatedAtPlatform)) {
        context.addIssue({ code: "custom", path: ["retiredAtPlatform"], message: "retired executor key needs an ordered retirement time" });
    }
});
export const AgentHomeMacExecutorKeyRotationSchema = z.object({
    meta: AgentHomeExecutorSignedMetaSchema,
    deviceServiceId: uuidSchema,
    previousKeyId: b64uSha256Schema,
    currentKeyEpoch: safePositiveIntegerSchema,
    nextKeyEpoch: safePositiveIntegerSchema,
    nextKeyId: b64uSha256Schema,
    nextPublicKey: spkiP256Schema,
}).strict().superRefine((value, context) => {
    checkSignedLifetime(value.meta, context);
    if (value.meta.signer !== "mac_executor")
        context.addIssue({ code: "custom", path: ["meta", "signer"], message: "Mac executor rotation is signed by the Mac executor" });
    if (value.meta.deviceServiceId !== value.deviceServiceId)
        context.addIssue({ code: "custom", path: ["meta", "deviceServiceId"], message: "rotation signer is bound to the device service" });
    if (value.meta.signerKeyId !== value.previousKeyId)
        context.addIssue({ code: "custom", path: ["meta", "signerKeyId"], message: "rotation is signed by the previous pinned key" });
    if (value.nextKeyEpoch !== value.currentKeyEpoch + 1)
        context.addIssue({ code: "custom", path: ["nextKeyEpoch"], message: "rotation advances key epoch exactly once" });
    if (value.nextKeyId === value.previousKeyId)
        context.addIssue({ code: "custom", path: ["nextKeyId"], message: "rotation installs a distinct key" });
});
export const AgentHomeExecutorLeaseFenceSchema = z.object({
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    homeEpoch: safePositiveIntegerSchema,
    executorTerm: safePositiveIntegerSchema,
    leaseId: uuidSchema,
    leaseExpiresAtPlatform: timestampSchema,
}).strict();
export const AgentHomeAuthorityFenceSchema = AgentHomeExecutorLeaseFenceSchema.extend({
    operation: AgentHomeOperationIdentitySchema,
}).strict();
export const AgentHomePlacementMoveSchema = z.object({
    moveId: uuidSchema,
    idempotencyKey: uuidSchema,
    intent: z.enum(["manual", "automatic_failover", "sleep_handoff", "go_home_when_idle"]),
    status: z.enum(["requested", "draining", "ready_to_commit", "committed", "aborted", "superseded"]),
    source: AgentHomeLocationSchema,
    target: AgentHomeLocationSchema,
    expectedHomeEpoch: safePositiveIntegerSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    requestedAtPlatform: timestampSchema,
}).strict().superRefine((value, context) => {
    if (sameLocation(value.source, value.target))
        context.addIssue({ code: "custom", path: ["target"], message: "move target must differ from source" });
});
export const AgentHomePlacementRecordSchema = z.object({
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    location: AgentHomeLocationSchema,
    homeEpoch: safePositiveIntegerSchema,
    placementRevision: safePositiveIntegerSchema,
    selectedGeneration: safePositiveIntegerSchema,
    rollbackFloorGeneration: safePositiveIntegerSchema,
    activeMove: AgentHomePlacementMoveSchema.nullable(),
    policyRevision: safePositiveIntegerSchema,
}).strict().superRefine((value, context) => {
    if (value.selectedGeneration < value.rollbackFloorGeneration) {
        context.addIssue({ code: "custom", path: ["selectedGeneration"], message: "selected generation is below rollback floor" });
    }
    if (value.activeMove?.status === "committed") {
        context.addIssue({ code: "custom", path: ["activeMove"], message: "activeMove clears when a move commits" });
    }
});
export const AgentHomeExecutorLeaseSchema = z.object({
    fence: AgentHomeExecutorLeaseFenceSchema,
    location: AgentHomeLocationSchema,
    issuedAtPlatform: timestampSchema,
    expiresAtPlatform: timestampSchema,
    status: z.enum(["active", "draining", "expired", "revoked"]),
}).strict().superRefine((value, context) => {
    if (value.expiresAtPlatform <= value.issuedAtPlatform) {
        context.addIssue({ code: "custom", path: ["expiresAtPlatform"], message: "executor lease must have a positive platform-time window" });
    }
});
const MoveRequestBaseSchema = z.object({
    meta: PlatformSignedMetaSchema,
    moveId: uuidSchema,
    idempotencyKey: uuidSchema,
    homeId: uuidSchema,
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    source: AgentHomeLocationSchema,
    target: AgentHomeLocationSchema,
    expectedHomeEpoch: safePositiveIntegerSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    requestedAtPlatform: timestampSchema,
});
export const AgentHomeAutomaticFailoverEvidenceSchema = z.object({
    pendingWork: z.object({
        eventLedgerIds: z.array(uuidSchema).max(10_000),
        occurrenceLedgerIds: z.array(uuidSchema).max(10_000),
        observedAtPlatform: timestampSchema,
        basis: z.literal("durable_event_and_occurrence_ledgers"),
    }).strict(),
    readiness: z.object({
        homeEpoch: safePositiveIntegerSchema,
        epochCommittedAtPlatform: timestampSchema,
        lastReadyAtPlatform: timestampSchema.nullable(),
        observedAtPlatform: timestampSchema,
        reachable: z.literal(false),
        powerState: z.enum(["awake", "asleep_wakeable", "asleep_not_wakeable", "unknown"]),
        unreachableSincePlatform: timestampSchema,
        wakeAttemptedAtPlatform: timestampSchema.nullable(),
        basis: z.literal("authenticated_agent_service_readiness"),
    }).strict(),
}).strict().superRefine((value, context) => {
    if (value.pendingWork.eventLedgerIds.length + value.pendingWork.occurrenceLedgerIds.length === 0) {
        context.addIssue({ code: "custom", path: ["pendingWork"], message: "automatic failover needs a durable pending-work ledger reference" });
    }
    if (value.readiness.lastReadyAtPlatform !== null && value.readiness.lastReadyAtPlatform > value.readiness.observedAtPlatform) {
        context.addIssue({ code: "custom", path: ["readiness", "lastReadyAtPlatform"], message: "last readiness cannot follow the platform observation" });
    }
    if (value.readiness.epochCommittedAtPlatform > value.readiness.observedAtPlatform) {
        context.addIssue({ code: "custom", path: ["readiness", "epochCommittedAtPlatform"], message: "epoch commit cannot follow the platform observation" });
    }
    if (value.readiness.unreachableSincePlatform > value.readiness.observedAtPlatform) {
        context.addIssue({ code: "custom", path: ["readiness", "unreachableSincePlatform"], message: "unreachable episode cannot begin after the platform observation" });
    }
    if (value.readiness.wakeAttemptedAtPlatform !== null && value.readiness.wakeAttemptedAtPlatform > value.readiness.observedAtPlatform) {
        context.addIssue({ code: "custom", path: ["readiness", "wakeAttemptedAtPlatform"], message: "wake attempt cannot follow the platform observation" });
    }
});
export const AgentHomeMoveRequestSchema = z.union([
    MoveRequestBaseSchema.extend({ intent: z.literal("manual"), priority: z.literal("manual"), trigger: z.literal("owner_request") }).strict(),
    MoveRequestBaseSchema.extend({ intent: z.literal("automatic_failover"), priority: z.literal("automatic"), trigger: z.literal("pending_unreachable"), evidence: AgentHomeAutomaticFailoverEvidenceSchema }).strict(),
    MoveRequestBaseSchema.extend({ intent: z.literal("go_home_when_idle"), priority: z.literal("automatic"), trigger: z.literal("idle_return") }).strict(),
    MoveRequestBaseSchema.extend({ intent: z.literal("sleep_handoff"), priority: z.literal("best_effort"), trigger: z.literal("sleep_signal") }).strict(),
]).superRefine((value, context) => {
    checkSignedLifetime(value.meta, context);
    if (sameLocation(value.source, value.target))
        context.addIssue({ code: "custom", path: ["target"], message: "move target must differ from source" });
});
const AgentHomeMoveDrainBaseSchema = z.object({
    meta: PlatformSignedMetaSchema,
    moveId: uuidSchema,
    fence: AgentHomeAuthorityFenceSchema,
    deadlineAtPlatform: timestampSchema,
});
export const AgentHomeMoveDrainSchema = z.union([
    AgentHomeMoveDrainBaseSchema.extend({ mode: z.literal("ordinary"), result: z.enum(["requested", "quiesced", "timed_out", "unreachable"]), fallback: z.literal("none") }).strict(),
    AgentHomeMoveDrainBaseSchema.extend({ mode: z.literal("best_effort_sleep"), result: z.enum(["requested", "quiesced"]), fallback: z.literal("none") }).strict(),
    AgentHomeMoveDrainBaseSchema.extend({ mode: z.literal("best_effort_sleep"), result: z.enum(["timed_out", "unreachable"]), fallback: z.literal("ordinary_slow_rule") }).strict(),
]).superRefine((value, context) => checkSignedLifetime(value.meta, context));
export const AgentHomeMoveCommitSchema = z.object({
    meta: PlatformSignedMetaSchema,
    moveId: uuidSchema,
    idempotencyKey: uuidSchema,
    source: AgentHomeLocationSchema,
    target: AgentHomeLocationSchema,
    expectedHomeEpoch: safePositiveIntegerSchema,
    nextHomeEpoch: safePositiveIntegerSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    nextPlacementRevision: safePositiveIntegerSchema,
    selectedGeneration: safePositiveIntegerSchema,
    rollbackFloorGeneration: safePositiveIntegerSchema,
    outcome: z.enum(["committed", "already_committed", "stale_cas", "superseded", "aborted"]),
    committedAtPlatform: timestampSchema.nullable(),
}).strict().superRefine((value, context) => {
    checkSignedLifetime(value.meta, context);
    if (sameLocation(value.source, value.target))
        context.addIssue({ code: "custom", path: ["target"], message: "move target must differ from source" });
    if (value.outcome === "committed" || value.outcome === "already_committed") {
        if (value.nextHomeEpoch !== value.expectedHomeEpoch + 1)
            context.addIssue({ code: "custom", path: ["nextHomeEpoch"], message: "move commit advances home epoch exactly once" });
        if (value.nextPlacementRevision !== value.expectedPlacementRevision + 1)
            context.addIssue({ code: "custom", path: ["nextPlacementRevision"], message: "move commit advances placement revision exactly once" });
        if (value.selectedGeneration < value.rollbackFloorGeneration)
            context.addIssue({ code: "custom", path: ["selectedGeneration"], message: "move cannot select below rollback floor" });
        if (value.committedAtPlatform === null)
            context.addIssue({ code: "custom", path: ["committedAtPlatform"], message: "committed move replay needs the original platform commit time" });
    }
});
export const AgentHomeMoveAbortSchema = z.object({
    meta: PlatformSignedMetaSchema,
    moveId: uuidSchema,
    idempotencyKey: uuidSchema,
    expectedHomeEpoch: safePositiveIntegerSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    reason: z.enum(["drain_failed", "target_unavailable", "owner_cancelled", "sleep_budget_elapsed"]),
    outcome: z.enum(["aborted", "already_aborted", "stale_cas", "committed_epoch_preserved"]),
}).strict().superRefine((value, context) => checkSignedLifetime(value.meta, context));
export const AgentHomeMoveSupersedeSchema = z.object({
    meta: PlatformSignedMetaSchema,
    winningMoveId: uuidSchema,
    supersededMoveId: uuidSchema,
    expectedHomeEpoch: safePositiveIntegerSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    winningIntent: z.literal("manual"),
    supersededIntent: z.enum(["manual", "automatic_failover", "sleep_handoff", "go_home_when_idle"]),
    outcome: z.enum(["superseded", "already_superseded", "committed_epoch_preserved"]),
}).strict().superRefine((value, context) => checkSignedLifetime(value.meta, context));
export const AgentHomePortableManifestEntrySchema = z.object({
    category: AgentHomePortableCategorySchema,
    path: z.string().min(1).max(4096),
    sha256: sha256Schema,
    bytes: safeNonnegativeIntegerSchema,
    stable: z.literal(true),
    fileType: z.literal("regular_file"),
    symlinkTraversal: z.literal("none"),
}).strict().superRefine((value, context) => {
    if (!isClosedPortablePath(value.category, value.path)) {
        context.addIssue({ code: "custom", path: ["path"], message: "portable manifest path is outside the closed category grammar or matches an excluded path" });
    }
});
export const AgentHomeCheckpointSkippedPathSchema = z.object({
    category: AgentHomePortableCategorySchema,
    reasonCode: AgentHomePortableSkipReasonSchema,
    count: safePositiveIntegerSchema,
    pathSha256: sha256Schema,
}).strict();
export const AgentHomePortableManifestSchema = z.object({
    homeId: uuidSchema,
    generation: safePositiveIntegerSchema,
    parentGeneration: safePositiveIntegerSchema,
    producingHomeEpoch: safePositiveIntegerSchema,
    manifestSha256: sha256Schema,
    entries: z.array(AgentHomePortableManifestEntrySchema).min(1).max(100_000),
    encryption: z.object({ encrypted: z.literal(true), keyScope: z.literal("owner_agent_home"), credentialMaterialIncluded: z.literal(false) }).strict(),
    contentPolicy: z.object({
        memory: z.literal("included"),
        skills: z.literal("included"),
        nonSecretConfig: z.literal("included"),
        routineDefinitions: z.literal("included"),
        portableAppData: z.literal("included"),
        sessionHistoryStateDb: z.literal("excluded"),
        packages: z.literal("excluded"),
        browserSessions: z.literal("excluded"),
        machineWorkspace: z.literal("excluded"),
        credentials: z.literal("excluded_all"),
    }).strict(),
}).strict().superRefine((value, context) => {
    if (value.parentGeneration >= value.generation)
        context.addIssue({ code: "custom", path: ["parentGeneration"], message: "parent must precede generation" });
});
export const AgentHomeCheckpointCaptureSchema = z.object({
    meta: AgentHomeExecutorSignedMetaSchema,
    fence: AgentHomeAuthorityFenceSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    generation: safePositiveIntegerSchema,
    parentGeneration: safePositiveIntegerSchema,
    dirty: z.literal(true),
    reason: z.enum(["cadence_dirty", "idle", "manual", "move_drain"]),
    manifestSha256: sha256Schema,
    includedFiles: safePositiveIntegerSchema,
    skipped: z.array(AgentHomeCheckpointSkippedPathSchema).max(100_000),
    consistency: z.object({ writersQuiesced: z.literal(true), sqliteMethod: z.literal("sqlite_backup"), stableFilesStaged: z.literal(true) }).strict(),
}).strict().superRefine((value, context) => {
    checkSignedLifetime(value.meta, context);
    if (value.parentGeneration >= value.generation)
        context.addIssue({ code: "custom", path: ["parentGeneration"], message: "parent must precede generation" });
});
export const AgentHomePortableCheckpointCommitSchema = z.object({
    meta: PlatformSignedMetaSchema,
    fence: AgentHomeAuthorityFenceSchema,
    expectedHomeEpoch: safePositiveIntegerSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    nextPlacementRevision: safePositiveIntegerSchema,
    generation: safePositiveIntegerSchema,
    selectedGenerationBefore: safePositiveIntegerSchema,
    parentGeneration: safePositiveIntegerSchema,
    producingHomeEpoch: safePositiveIntegerSchema,
    eraseEpoch: safePositiveIntegerSchema,
    manifestSha256: sha256Schema,
    uploadVerified: z.boolean(),
    outcome: z.enum(["committed", "already_committed", "stale_epoch", "stale_revision", "verification_failed"]),
}).strict().superRefine((value, context) => {
    checkSignedLifetime(value.meta, context);
    if (value.expectedHomeEpoch !== value.fence.homeEpoch)
        context.addIssue({ code: "custom", path: ["expectedHomeEpoch"], message: "checkpoint epoch must match fence" });
    if (value.producingHomeEpoch !== value.fence.homeEpoch)
        context.addIssue({ code: "custom", path: ["producingHomeEpoch"], message: "producing epoch must match fence" });
    if (value.parentGeneration >= value.generation)
        context.addIssue({ code: "custom", path: ["parentGeneration"], message: "parent must precede generation" });
    if (value.generation <= value.selectedGenerationBefore)
        context.addIssue({ code: "custom", path: ["generation"], message: "checkpoint generation must strictly advance selected generation" });
    if (value.parentGeneration !== value.selectedGenerationBefore)
        context.addIssue({ code: "custom", path: ["parentGeneration"], message: "checkpoint parent must equal the currently selected generation" });
    if ((value.outcome === "committed" || value.outcome === "already_committed") && !value.uploadVerified) {
        context.addIssue({ code: "custom", path: ["uploadVerified"], message: "successful checkpoint commit requires verified upload bytes" });
    }
    if (value.outcome === "verification_failed" && value.uploadVerified) {
        context.addIssue({ code: "custom", path: ["uploadVerified"], message: "verification failure records unverified upload bytes" });
    }
    if (value.outcome === "committed" && value.nextPlacementRevision !== value.expectedPlacementRevision + 1) {
        context.addIssue({ code: "custom", path: ["nextPlacementRevision"], message: "checkpoint advances placement revision exactly once" });
    }
});
export const AgentHomeCheckpointResultSchema = z.union([
    z.object({
        checkpointId: uuidSchema,
        outcome: z.literal("committed"),
        generation: safePositiveIntegerSchema,
        selectedGeneration: safePositiveIntegerSchema,
        placementRevision: safePositiveIntegerSchema,
        manifestSha256: sha256Schema,
    }).strict(),
    z.object({
        checkpointId: uuidSchema,
        outcome: z.literal("failed_previous_selected"),
        attemptedGeneration: safePositiveIntegerSchema,
        selectedGenerationBefore: safePositiveIntegerSchema,
        selectedGenerationAfter: safePositiveIntegerSchema,
        placementRevisionBefore: safePositiveIntegerSchema,
        placementRevisionAfter: safePositiveIntegerSchema,
        reason: z.enum(["quiesce_failed", "sqlite_backup_failed", "staging_failed", "upload_failed", "verification_failed", "stale_epoch"]),
    }).strict().superRefine((value, context) => {
        if (value.selectedGenerationBefore !== value.selectedGenerationAfter)
            context.addIssue({ code: "custom", path: ["selectedGenerationAfter"], message: "failed checkpoint keeps prior generation selected" });
        if (value.placementRevisionBefore !== value.placementRevisionAfter)
            context.addIssue({ code: "custom", path: ["placementRevisionAfter"], message: "failed checkpoint keeps prior placement revision" });
    }),
]);
export const AgentHomeReadinessReportSchema = z.object({
    meta: AgentHomeExecutorSignedMetaSchema,
    fence: AgentHomeExecutorLeaseFenceSchema,
    reportedAtLocal: timestampSchema,
    powerState: z.enum(["awake", "asleep_wakeable", "asleep_not_wakeable", "unknown"]),
    checks: z.object({ homeAccessible: z.boolean(), runtimeUsable: z.boolean(), matrixIntakeWorking: z.boolean() }).strict(),
}).strict().superRefine((value, context) => checkSignedLifetime(value.meta, context));
export const AgentHomeReadinessObservationSchema = z.object({
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    homeEpoch: safePositiveIntegerSchema,
    receivedAtPlatform: timestampSchema,
    lastReadyAtPlatform: timestampSchema.nullable(),
    reachable: z.boolean(),
    powerState: z.enum(["awake", "asleep_wakeable", "asleep_not_wakeable", "unknown"]),
    basis: z.literal("authenticated_agent_service_readiness"),
}).strict().superRefine((value, context) => {
    if (value.lastReadyAtPlatform !== null && value.lastReadyAtPlatform > value.receivedAtPlatform) {
        context.addIssue({ code: "custom", path: ["lastReadyAtPlatform"], message: "platform readiness time cannot be in the future" });
    }
    if (value.reachable && value.powerState === "asleep_not_wakeable") {
        context.addIssue({ code: "custom", path: ["reachable"], message: "an asleep, non-wakeable home is not reachable" });
    }
});
const EventLedgerEntrySchema = z.object({
    id: uuidSchema,
    state: z.enum(["queued", "taken", "dispatched", "completed", "stopped", "uncertain"]),
}).strict();
const OccurrenceLedgerEntrySchema = z.object({
    id: uuidSchema,
    state: z.enum(["due", "claimed", "completed", "stopped"]),
    dueAt: timestampSchema,
}).strict();
export const AgentHomePendingWorkSnapshotSchema = z.object({
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    observedAtPlatform: timestampSchema,
    eventLedger: z.array(EventLedgerEntrySchema).max(10_000),
    occurrenceLedger: z.array(OccurrenceLedgerEntrySchema).max(10_000),
    basis: z.literal("durable_event_and_occurrence_ledgers"),
    visibleReplyStateIgnored: z.literal(true),
}).strict();
const AgentHomeDestinationPolicySchema = z.object({ destination: AgentHomeLocationSchema, enabled: z.boolean() }).strict();
export const AgentHomePolicySchema = z.object({
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    revision: safePositiveIntegerSchema,
    backupEnabled: z.boolean(),
    neverRunInCloud: z.boolean(),
    checkpointCadenceMs: z.number().int().min(60_000).max(86_400_000),
    failoverDelayMs: z.number().int().min(60_000).max(86_400_000),
    eligibilitySweepMs: z.number().int().min(30_000).max(300_000),
    fallbackOrder: z.array(AgentHomeDestinationPolicySchema).min(1).max(32),
    returnMode: z.enum(["stay_put", "go_home_when_idle"]),
}).strict().superRefine((value, context) => {
    const identities = value.fallbackOrder.map(({ destination }) => locationKey(destination));
    if (new Set(identities).size !== identities.length)
        context.addIssue({ code: "custom", path: ["fallbackOrder"], message: "fallback destinations must be unique" });
    if (value.neverRunInCloud && value.fallbackOrder.some(({ destination, enabled }) => destination.kind === "cloud" && enabled)) {
        context.addIssue({ code: "custom", path: ["fallbackOrder"], message: "never-run-in-cloud policy cannot enable a cloud destination" });
    }
});
export const AgentHomeProtectedOperationSchema = z.object({
    kind: z.enum(["work_admission", "checkpoint", "connector_effect", "device_effect", "matrix_publication"]),
    meta: AgentHomeExecutorSignedMetaSchema,
    fence: AgentHomeAuthorityFenceSchema,
    placement: AgentHomeLocationSchema,
    requestedAtPlatform: timestampSchema,
}).strict().superRefine((value, context) => checkSignedLifetime(value.meta, context));
const AuthorityAcceptedSchema = z.object({ outcome: z.literal("accepted"), reason: z.literal("current_authority") }).strict();
const AuthorityRefusedSchema = z.object({
    outcome: z.literal("refused"),
    reason: z.enum(["wrong_owner", "wrong_agent", "wrong_home", "stale_home_epoch", "stale_executor_term", "wrong_operation", "wrong_lease", "lease_expired", "wrong_signer_location", "unpinned_signer_key", "bad_signature", "signature_expired"]),
}).strict();
export const AgentHomeAuthorityCaseSchema = z.object({
    kind: z.enum(["work_admission", "checkpoint", "connector_effect", "device_effect", "matrix_publication"]),
    presented: z.object({ meta: AgentHomeExecutorSignedMetaSchema, fence: AgentHomeAuthorityFenceSchema }).strict(),
    trusted: z.object({
        ownerUserId: userIdSchema,
        agentPrincipal: uuidSchema,
        homeId: uuidSchema,
        homeEpoch: safePositiveIntegerSchema,
        executorTerm: safePositiveIntegerSchema,
        leaseId: uuidSchema,
        leaseExpiresAtPlatform: timestampSchema,
        operation: AgentHomeOperationIdentitySchema,
        placement: AgentHomeLocationSchema,
        pinnedSignerKeyId: b64uSha256Schema,
        signatureValid: z.boolean(),
        nowPlatform: timestampSchema,
    }).strict(),
    expect: z.union([AuthorityAcceptedSchema, AuthorityRefusedSchema]),
}).strict();
export const MatrixHomePublicationEnqueueSchema = z.object({
    meta: AgentHomeExecutorSignedMetaSchema,
    fence: AgentHomeAuthorityFenceSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    moveSerializationRevision: safePositiveIntegerSchema,
    outboxId: uuidSchema,
    roomId: roomIdSchema,
    transactionId: z.string().min(1).max(255),
    payloadSha256: sha256Schema,
}).strict().superRefine((value, context) => {
    checkSignedLifetime(value.meta, context);
    if (value.moveSerializationRevision !== value.expectedPlacementRevision) {
        context.addIssue({ code: "custom", path: ["moveSerializationRevision"], message: "publication serialization revision must match expected placement revision" });
    }
});
export const MatrixHomePublicationReceiptSchema = z.object({
    outboxId: uuidSchema,
    fence: AgentHomeAuthorityFenceSchema,
    moveSerializationRevision: safePositiveIntegerSchema,
    state: z.enum(["queued", "admitted", "sending", "published", "refused", "uncertain"]),
    eventId: eventIdSchema.nullable(),
    reason: z.enum(["stale_authority", "move_in_progress", "matrix_error", "effect_unknown"]).nullable(),
}).strict().superRefine((value, context) => {
    if (value.state === "published" && value.eventId === null)
        context.addIssue({ code: "custom", path: ["eventId"], message: "published receipt needs Matrix event id" });
    if (value.state === "published" && value.reason !== null)
        context.addIssue({ code: "custom", path: ["reason"], message: "published receipt has no refusal reason" });
    if (value.state === "refused" && value.eventId !== null)
        context.addIssue({ code: "custom", path: ["eventId"], message: "refused publication has no Matrix event id" });
    if (value.state === "sending" && value.reason !== null)
        context.addIssue({ code: "custom", path: ["reason"], message: "sending publication has no refusal reason" });
});
export const AgentHomeUnledgeredPublicationKindSchema = z.enum(AGENT_HOME_UNLEDGERED_PUBLICATION_KINDS);
const unledgeredPublicationClientKeySchema = z.string().min(1)
    .max(AGENT_HOME_UNLEDGERED_PUBLICATION_MAX_CLIENT_KEY_BYTES)
    .regex(/^[!-~]+$/u);
export const MatrixHomeUnledgeredPublicationEnqueueSchema = z.object({
    meta: AgentHomeExecutorSignedMetaSchema,
    fence: AgentHomeExecutorLeaseFenceSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    moveSerializationRevision: safePositiveIntegerSchema,
    outboxId: uuidSchema,
    publicationKind: AgentHomeUnledgeredPublicationKindSchema,
    clientKey: unledgeredPublicationClientKeySchema,
    roomId: roomIdSchema,
    transactionId: z.string().min(1).max(255),
    payloadSha256: sha256Schema,
    payloadBytes: z.number().int().min(2).max(AGENT_HOME_UNLEDGERED_PUBLICATION_MAX_PAYLOAD_BYTES),
}).strict().superRefine((value, context) => {
    checkSignedLifetime(value.meta, context);
    if (value.moveSerializationRevision !== value.expectedPlacementRevision) {
        context.addIssue({ code: "custom", path: ["moveSerializationRevision"], message: "publication serialization revision must match expected placement revision" });
    }
});
export const MatrixHomeUnledgeredPublicationReceiptSchema = z.object({
    outboxId: uuidSchema,
    fence: AgentHomeExecutorLeaseFenceSchema,
    publicationKind: AgentHomeUnledgeredPublicationKindSchema,
    clientKey: unledgeredPublicationClientKeySchema,
    moveSerializationRevision: safePositiveIntegerSchema,
    state: z.enum(["queued", "admitted", "sending", "published", "refused", "uncertain"]),
    eventId: eventIdSchema.nullable(),
    reason: z.enum(["stale_authority", "move_in_progress", "matrix_error", "effect_unknown"]).nullable(),
}).strict().superRefine((value, context) => {
    if (value.state === "published" && value.eventId === null)
        context.addIssue({ code: "custom", path: ["eventId"], message: "published receipt needs Matrix event id" });
    if (value.state === "published" && value.reason !== null)
        context.addIssue({ code: "custom", path: ["reason"], message: "published receipt has no refusal reason" });
    if (value.state === "refused" && value.eventId !== null)
        context.addIssue({ code: "custom", path: ["eventId"], message: "refused publication has no Matrix event id" });
    if (value.state === "sending" && value.reason !== null)
        context.addIssue({ code: "custom", path: ["reason"], message: "sending publication has no refusal reason" });
});
function unledgeredPublicationReplayBytes(value) {
    return canonicalJson({
        signerKeyId: value.meta.signerKeyId,
        deviceServiceId: value.meta.deviceServiceId,
        fence: value.fence,
        expectedPlacementRevision: value.expectedPlacementRevision,
        moveSerializationRevision: value.moveSerializationRevision,
        outboxId: value.outboxId,
        publicationKind: value.publicationKind,
        clientKey: value.clientKey,
        roomId: value.roomId,
        transactionId: value.transactionId,
        payloadSha256: value.payloadSha256,
        payloadBytes: value.payloadBytes,
    });
}
export function decideAgentHomeUnledgeredPublicationReplay(stored, replay) {
    return { outcome: unledgeredPublicationReplayBytes(stored) === unledgeredPublicationReplayBytes(replay)
            ? "exact_replay" : "idempotency_conflict" };
}
export function decideAgentHomeUnledgeredPublicationKeyReuse(prior, currentHomeEpoch) {
    return { outcome: prior.state === "refused" && prior.eventId === null && prior.homeEpoch < currentHomeEpoch
            ? "supersede_refused" : "retain_key" };
}
export const AgentHomeReturnReportSchema = z.object({
    meta: AgentHomeExecutorSignedMetaSchema,
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    location: AgentHomeLocationSchema,
    sourceHomeEpoch: safePositiveIntegerSchema,
    eraseEpoch: safePositiveIntegerSchema,
    observedPlacementRevision: safePositiveIntegerSchema,
    observedMoveId: uuidSchema.nullable(),
    baseGeneration: safePositiveIntegerSchema,
    sourceManifestSha256: sha256Schema,
    currentManifestSha256: sha256Schema,
    divergent: z.literal(true),
}).strict().superRefine((value, context) => checkSignedLifetime(value.meta, context));
export const AgentHomeConflictQuarantineSchema = z.object({
    quarantineId: uuidSchema,
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    sourceLocation: AgentHomeLocationSchema,
    sourceHomeEpoch: safePositiveIntegerSchema,
    baseGeneration: safePositiveIntegerSchema,
    sourceManifestSha256: sha256Schema,
    currentManifestSha256: sha256Schema,
    status: z.literal("quarantined"),
    autoPromoted: z.literal(false),
    autoMerged: z.literal(false),
    sessionHistoryIncluded: z.literal(false),
}).strict();
export const AgentHomeConflictImportSchema = z.object({
    meta: PlatformSignedMetaSchema,
    fence: AgentHomeAuthorityFenceSchema,
    quarantineId: uuidSchema,
    reviewId: uuidSchema,
    reviewedBy: userIdSchema,
    eraseEpoch: safePositiveIntegerSchema,
    expectedHomeEpoch: safePositiveIntegerSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    nextPlacementRevision: safePositiveIntegerSchema,
    parentGeneration: safePositiveIntegerSchema,
    generation: safePositiveIntegerSchema,
    sourceManifestSha256: sha256Schema,
    outcome: z.enum(["imported", "refused", "stale_cas"]),
}).strict().superRefine((value, context) => {
    checkSignedLifetime(value.meta, context);
    if (value.expectedHomeEpoch !== value.fence.homeEpoch)
        context.addIssue({ code: "custom", path: ["expectedHomeEpoch"], message: "reviewed import epoch must match fence" });
    if (value.reviewedBy !== value.fence.ownerUserId)
        context.addIssue({ code: "custom", path: ["reviewedBy"], message: "conflict import must be reviewed by the owner" });
    if (value.outcome === "imported" && value.nextPlacementRevision !== value.expectedPlacementRevision + 1) {
        context.addIssue({ code: "custom", path: ["nextPlacementRevision"], message: "reviewed import advances placement revision once" });
    }
    if (value.outcome === "imported" && value.parentGeneration >= value.generation) {
        context.addIssue({ code: "custom", path: ["parentGeneration"], message: "reviewed import creates a later generation" });
    }
});
const AgentHomeEraseLocationSchema = z.object({ location: AgentHomeLocationSchema, state: z.enum(["erased", "pending_offline"]) }).strict();
export const AgentHomeEraseFenceSchema = z.object({
    erasureId: uuidSchema,
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    eraseEpoch: safePositiveIntegerSchema,
    issuedAtPlatform: timestampSchema,
    expiresAtPlatform: timestampSchema,
}).strict().superRefine((value, context) => {
    if (value.expiresAtPlatform <= value.issuedAtPlatform || value.expiresAtPlatform > value.issuedAtPlatform + SIGNED_MESSAGE_MAX_MS) {
        context.addIssue({ code: "custom", path: ["expiresAtPlatform"], message: "erase fence has a positive, bounded platform-time window" });
    }
});
export const AgentHomeEraseRequestSchema = z.object({
    meta: PlatformSignedMetaSchema,
    eraseFence: AgentHomeEraseFenceSchema,
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    expectedPlacementRevision: safePositiveIntegerSchema,
    eraseEpoch: safePositiveIntegerSchema,
    locations: z.array(AgentHomeLocationSchema).min(1).max(32),
    scopes: z.object({
        workingHome: z.literal(true), checkpoints: z.literal(true), snapshots: z.literal(true),
        quarantinedConflicts: z.literal(true), credentials: z.literal(true),
    }).strict(),
}).strict().superRefine((value, context) => {
    checkSignedLifetime(value.meta, context);
    const keys = value.locations.map(locationKey);
    if (new Set(keys).size !== keys.length)
        context.addIssue({ code: "custom", path: ["locations"], message: "erase locations must be unique" });
});
export const AgentHomeEraseReceiptSchema = z.object({
    meta: AgentHomeExecutorSignedMetaSchema,
    eraseFence: AgentHomeEraseFenceSchema,
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    eraseEpoch: safePositiveIntegerSchema,
    outcome: z.enum(["complete", "pending_offline"]),
    requestedLocations: z.array(AgentHomeLocationSchema).min(1).max(32),
    coveredLocations: z.array(AgentHomeLocationSchema).max(32),
    locations: z.array(AgentHomeEraseLocationSchema).min(1).max(32),
    resurrection: z.literal("forbidden"),
    tombstoneDurable: z.literal(true),
}).strict().superRefine((value, context) => {
    checkSignedLifetime(value.meta, context);
    const requested = value.requestedLocations.map(locationKey);
    const covered = value.coveredLocations.map(locationKey);
    const reported = value.locations.map(({ location }) => locationKey(location));
    if (new Set(requested).size !== requested.length)
        context.addIssue({ code: "custom", path: ["requestedLocations"], message: "requested erase locations must be unique" });
    if (new Set(covered).size !== covered.length)
        context.addIssue({ code: "custom", path: ["coveredLocations"], message: "covered erase locations must be unique" });
    if (new Set(reported).size !== reported.length)
        context.addIssue({ code: "custom", path: ["locations"], message: "erase location records must be unique" });
    const requestedSet = new Set(requested);
    if (reported.length !== requestedSet.size || reported.some((key) => !requestedSet.has(key))) {
        context.addIssue({ code: "custom", path: ["locations"], message: "every requested location must be reported as erased or pending" });
    }
    const erased = value.locations.filter(({ state }) => state === "erased").map(({ location }) => locationKey(location));
    const coveredSet = new Set(covered);
    if (erased.length !== coveredSet.size || erased.some((key) => !coveredSet.has(key))) {
        context.addIssue({ code: "custom", path: ["coveredLocations"], message: "covered locations must equal the erased location records" });
    }
    if (value.outcome === "complete" && value.locations.some(({ state }) => state === "pending_offline")) {
        context.addIssue({ code: "custom", path: ["locations"], message: "complete erase cannot retain an offline deletion" });
    }
    if (value.outcome === "complete") {
        if (requestedSet.size !== coveredSet.size || [...requestedSet].some((key) => !coveredSet.has(key))) {
            context.addIssue({ code: "custom", path: ["coveredLocations"], message: "complete erase receipt covers every requested location" });
        }
    }
});
export const AgentHomeEraseTombstoneSchema = z.object({
    erasureId: uuidSchema,
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    eraseEpoch: safePositiveIntegerSchema,
    requestedLocations: z.array(AgentHomeLocationSchema).min(1).max(32),
    erasedLocations: z.array(AgentHomeLocationSchema).max(32),
    status: z.enum(["pending_offline", "complete"]),
    committedAtPlatform: timestampSchema,
}).strict().superRefine((value, context) => {
    const requested = new Set(value.requestedLocations.map(locationKey));
    const erased = value.erasedLocations.map(locationKey);
    if (new Set(erased).size !== erased.length || erased.some((key) => !requested.has(key))) {
        context.addIssue({ code: "custom", path: ["erasedLocations"], message: "tombstone erased locations are unique members of the erase request" });
    }
    if (value.status === "complete" && erased.length !== requested.size) {
        context.addIssue({ code: "custom", path: ["erasedLocations"], message: "complete tombstone covers every requested location" });
    }
});
export const AgentHomeRestoreRequestSchema = z.object({
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    sourceGeneration: safePositiveIntegerSchema,
    observedEraseEpoch: safePositiveIntegerSchema,
}).strict();
export const AgentHomePortableRestoreRecordSchema = z.object({
    ownerUserId: userIdSchema,
    agentPrincipal: uuidSchema,
    homeId: uuidSchema,
    sourceGeneration: safePositiveIntegerSchema,
    checkedEraseEpoch: safePositiveIntegerSchema,
    browserSessionsOnRestore: z.literal("excluded"),
    freshBrowserSignInRequired: z.literal(true),
}).strict();
export const AgentHomeMoveArbitrationCaseSchema = z.object({
    current: AgentHomePlacementMoveSchema,
    incoming: AgentHomePlacementMoveSchema,
    expect: z.union([
        z.object({ outcome: z.literal("replay"), reason: z.enum(["same_intent", "already_committed_exact_epoch"]) }).strict(),
        z.object({ outcome: z.literal("fresh"), reason: z.enum(["terminal_move_replaced", "committed_history_advanced"]) }).strict(),
        z.object({ outcome: z.literal("supersede"), reason: z.enum(["manual_beats_uncommitted_automation", "manual_retargets_uncommitted_manual"]) }).strict(),
        z.object({ outcome: z.literal("refused"), reason: z.enum(["committed_epoch_preserved", "committed_epoch_mismatch", "automatic_cannot_supersede", "idempotency_conflict"]) }).strict(),
    ]),
}).strict();
export const AgentHomeFailoverCaseSchema = z.object({
    nowPlatform: timestampSchema,
    lastReadyAtPlatform: timestampSchema.nullable(),
    epochCommittedAtPlatform: timestampSchema,
    localClock: timestampSchema,
    pendingEvents: safeNonnegativeIntegerSchema,
    dueOccurrences: safeNonnegativeIntegerSchema,
    homeReachable: z.boolean(),
    homePowerState: z.enum(["awake", "asleep_wakeable", "asleep_not_wakeable", "unknown"]),
    unreachableSincePlatform: timestampSchema,
    wakeAttemptedAtPlatform: timestampSchema.nullable(),
    currentLocation: AgentHomeLocationSchema,
    policy: AgentHomePolicySchema,
    availableDestinations: z.array(AgentHomeLocationSchema).max(32),
    expect: z.union([
        z.object({ outcome: z.literal("move"), target: AgentHomeLocationSchema, reason: z.literal("pending_and_unreachable") }).strict(),
        z.object({ outcome: z.literal("wake"), reason: z.literal("asleep_wakeable"), graceUntilPlatform: timestampSchema }).strict(),
        z.object({ outcome: z.literal("stay"), reason: z.enum(["no_pending_work", "failover_delay_not_elapsed", "home_ready", "wake_grace_not_elapsed"]) }).strict(),
        z.object({ outcome: z.literal("unavailable"), reason: z.enum(["no_enabled_destination", "strictly_local_home_lost", "state_unrecoverable_without_backup"]) }).strict(),
    ]),
}).strict().superRefine((value, context) => {
    if (value.homeReachable && value.homePowerState === "asleep_not_wakeable")
        context.addIssue({ code: "custom", path: ["homeReachable"], message: "non-wakeable sleeping home is not reachable" });
    if (value.unreachableSincePlatform > value.nowPlatform)
        context.addIssue({ code: "custom", path: ["unreachableSincePlatform"], message: "unreachable episode cannot begin in the future" });
    if (value.wakeAttemptedAtPlatform !== null && value.wakeAttemptedAtPlatform > value.nowPlatform)
        context.addIssue({ code: "custom", path: ["wakeAttemptedAtPlatform"], message: "wake attempt cannot be in the future" });
});
export const AgentHomeIdleReturnCaseSchema = z.object({
    idle: z.boolean(),
    currentLocation: AgentHomeLocationSchema,
    preferredHome: AgentHomeLocationSchema,
    policy: AgentHomePolicySchema,
    expect: z.union([
        z.object({ outcome: z.literal("move"), target: AgentHomeLocationSchema, reason: z.literal("idle_return_enabled") }).strict(),
        z.object({ outcome: z.literal("refused"), reason: z.literal("stay_put_policy") }).strict(),
        z.object({ outcome: z.literal("stay"), reason: z.enum(["not_idle", "already_home"]) }).strict(),
    ]),
}).strict();
export const AgentHomeEraseReceiptCaseSchema = z.object({
    request: AgentHomeEraseRequestSchema,
    receipt: AgentHomeEraseReceiptSchema,
    expect: z.union([
        z.object({ outcome: z.literal("accepted"), reason: z.literal("erase_fence_and_locations_match") }).strict(),
        z.object({ outcome: z.literal("refused"), reason: z.enum(["erase_fence_mismatch", "incomplete_location_coverage"]) }).strict(),
    ]),
}).strict();
export const AgentHomePostEraseCaseSchema = z.object({
    tombstone: AgentHomeEraseTombstoneSchema,
    operation: z.object({
        kind: z.enum(["checkpoint_commit", "conflict_import", "return_report"]),
        ownerUserId: userIdSchema,
        agentPrincipal: uuidSchema,
        homeId: uuidSchema,
        eraseEpoch: safePositiveIntegerSchema,
    }).strict(),
    expect: z.union([
        z.object({ outcome: z.literal("accepted"), reason: z.literal("different_home") }).strict(),
        z.object({ outcome: z.literal("refused"), reason: z.literal("erase_tombstone_fence") }).strict(),
    ]),
}).strict();
export function decideAgentHomeAuthorityAdmission(presented, trusted) {
    const { fence, meta } = presented;
    if (fence.ownerUserId !== trusted.ownerUserId)
        return { outcome: "refused", reason: "wrong_owner" };
    if (fence.agentPrincipal !== trusted.agentPrincipal)
        return { outcome: "refused", reason: "wrong_agent" };
    if (fence.homeId !== trusted.homeId)
        return { outcome: "refused", reason: "wrong_home" };
    if (fence.homeEpoch !== trusted.homeEpoch)
        return { outcome: "refused", reason: "stale_home_epoch" };
    if (fence.executorTerm !== trusted.executorTerm)
        return { outcome: "refused", reason: "stale_executor_term" };
    if (fence.operation.kind !== trusted.operation.kind || fence.operation.id !== trusted.operation.id)
        return { outcome: "refused", reason: "wrong_operation" };
    if (fence.leaseId !== trusted.leaseId || fence.leaseExpiresAtPlatform !== trusted.leaseExpiresAtPlatform)
        return { outcome: "refused", reason: "wrong_lease" };
    if (trusted.leaseExpiresAtPlatform <= trusted.nowPlatform)
        return { outcome: "refused", reason: "lease_expired" };
    if (meta.issuedAt > trusted.nowPlatform || meta.expiresAt <= trusted.nowPlatform || meta.expiresAt > meta.issuedAt + SIGNED_MESSAGE_MAX_MS) {
        return { outcome: "refused", reason: "signature_expired" };
    }
    const signerMatches = trusted.placement.kind === "cloud"
        ? meta.signer === "cloud_workload"
        : meta.signer === "mac_executor" && meta.deviceServiceId === trusted.placement.deviceServiceId;
    if (!signerMatches)
        return { outcome: "refused", reason: "wrong_signer_location" };
    if (meta.signerKeyId !== trusted.pinnedSignerKeyId)
        return { outcome: "refused", reason: "unpinned_signer_key" };
    if (!trusted.signatureValid)
        return { outcome: "refused", reason: "bad_signature" };
    return { outcome: "accepted", reason: "current_authority" };
}
export function decideAgentHomeMoveArbitration(current, incoming) {
    if (current.status === "aborted" || current.status === "superseded")
        return { outcome: "fresh", reason: "terminal_move_replaced" };
    const sameKey = current.idempotencyKey === incoming.idempotencyKey;
    const exactEpoch = current.expectedHomeEpoch === incoming.expectedHomeEpoch
        && current.expectedPlacementRevision === incoming.expectedPlacementRevision
        && current.intent === incoming.intent
        && sameLocation(current.source, incoming.source)
        && sameLocation(current.target, incoming.target);
    if (current.status === "committed") {
        if (sameKey && exactEpoch)
            return { outcome: "replay", reason: "already_committed_exact_epoch" };
        if (sameKey)
            return { outcome: "refused", reason: "committed_epoch_mismatch" };
        const committedHomeEpoch = current.expectedHomeEpoch + 1;
        const committedPlacementRevision = current.expectedPlacementRevision + 1;
        if (incoming.expectedHomeEpoch >= committedHomeEpoch && incoming.expectedPlacementRevision >= committedPlacementRevision) {
            return { outcome: "fresh", reason: "committed_history_advanced" };
        }
        return { outcome: "refused", reason: "committed_epoch_preserved" };
    }
    if (sameKey && exactEpoch)
        return { outcome: "replay", reason: "same_intent" };
    if (sameKey)
        return { outcome: "refused", reason: "idempotency_conflict" };
    if (incoming.intent === "manual" && current.intent === "manual") {
        return { outcome: "supersede", reason: "manual_retargets_uncommitted_manual" };
    }
    if (incoming.intent === "manual" && ["automatic_failover", "sleep_handoff", "go_home_when_idle"].includes(current.intent)) {
        return { outcome: "supersede", reason: "manual_beats_uncommitted_automation" };
    }
    return { outcome: "refused", reason: "automatic_cannot_supersede" };
}
export function decideAgentHomeFailover(input) {
    if (input.pendingEvents === 0 && input.dueOccurrences === 0)
        return { outcome: "stay", reason: "no_pending_work" };
    if (input.homeReachable)
        return { outcome: "stay", reason: "home_ready" };
    const lastAuthorityProof = Math.max(input.epochCommittedAtPlatform, input.lastReadyAtPlatform ?? 0);
    if (input.nowPlatform - lastAuthorityProof < input.policy.failoverDelayMs) {
        return { outcome: "stay", reason: "failover_delay_not_elapsed" };
    }
    if (input.homePowerState === "asleep_wakeable") {
        if (input.wakeAttemptedAtPlatform === null || input.wakeAttemptedAtPlatform < input.unreachableSincePlatform) {
            return { outcome: "wake", reason: "asleep_wakeable", graceUntilPlatform: input.nowPlatform + input.policy.eligibilitySweepMs };
        }
        if (input.nowPlatform - input.wakeAttemptedAtPlatform < input.policy.eligibilitySweepMs) {
            return { outcome: "stay", reason: "wake_grace_not_elapsed" };
        }
    }
    const available = new Set(input.availableDestinations.map(locationKey));
    const target = input.policy.fallbackOrder.find(({ destination, enabled }) => enabled && locationKey(destination) !== locationKey(input.currentLocation)
        && !(input.policy.neverRunInCloud && destination.kind === "cloud") && available.has(locationKey(destination)))?.destination;
    if (target)
        return { outcome: "move", target, reason: "pending_and_unreachable" };
    if (input.policy.neverRunInCloud && !input.policy.backupEnabled)
        return { outcome: "unavailable", reason: "state_unrecoverable_without_backup" };
    if (input.policy.neverRunInCloud)
        return { outcome: "unavailable", reason: "strictly_local_home_lost" };
    return { outcome: "unavailable", reason: "no_enabled_destination" };
}
export function decidePortableCheckpointCommit(proposed, current) {
    if (!proposed.uploadVerified)
        return { outcome: "refused", reason: "verification_failed" };
    if (proposed.expectedHomeEpoch !== current.homeEpoch)
        return { outcome: "refused", reason: "stale_epoch" };
    if (proposed.expectedPlacementRevision !== current.placementRevision)
        return { outcome: "refused", reason: "stale_revision" };
    if (proposed.parentGeneration !== current.selectedGeneration || proposed.parentGeneration >= proposed.generation || proposed.generation <= current.selectedGeneration) {
        return { outcome: "refused", reason: "invalid_generation" };
    }
    return { outcome: "committed", nextPlacementRevision: current.placementRevision + 1 };
}
export function hasAgentHomePendingWork(snapshot) {
    return snapshot.eventLedger.some(({ state }) => ["queued", "taken", "dispatched", "uncertain"].includes(state))
        || snapshot.occurrenceLedger.some(({ state }) => state === "due" || state === "claimed");
}
export function decideAgentHomeAutomaticMoveRequest(request, nowPlatform, failoverDelayMs, eligibilitySweepMs = AGENT_HOME_DEFAULT_ELIGIBILITY_SWEEP_MS) {
    const { evidence } = request;
    if (evidence.pendingWork.eventLedgerIds.length + evidence.pendingWork.occurrenceLedgerIds.length === 0)
        return { outcome: "refused", reason: "missing_pending_work_evidence" };
    if (evidence.readiness.reachable)
        return { outcome: "refused", reason: "home_ready" };
    if (evidence.readiness.homeEpoch !== request.expectedHomeEpoch)
        return { outcome: "refused", reason: "stale_home_epoch" };
    const lastAuthorityProof = Math.max(evidence.readiness.epochCommittedAtPlatform, evidence.readiness.lastReadyAtPlatform ?? 0);
    if (nowPlatform - lastAuthorityProof < failoverDelayMs)
        return { outcome: "refused", reason: "failover_delay_not_elapsed" };
    if (evidence.readiness.powerState === "asleep_wakeable") {
        const wakeAttempt = evidence.readiness.wakeAttemptedAtPlatform;
        if (wakeAttempt === null || wakeAttempt < evidence.readiness.unreachableSincePlatform) {
            return { outcome: "wake", reason: "asleep_wakeable", graceUntilPlatform: nowPlatform + eligibilitySweepMs };
        }
        if (nowPlatform - wakeAttempt < eligibilitySweepMs)
            return { outcome: "refused", reason: "wake_grace_not_elapsed" };
    }
    return { outcome: "accepted", reason: "pending_and_unreachable_evidence" };
}
export function decideAgentHomeIdleReturn(input) {
    if (input.policy.returnMode === "stay_put")
        return { outcome: "refused", reason: "stay_put_policy" };
    if (!input.idle)
        return { outcome: "stay", reason: "not_idle" };
    if (sameLocation(input.currentLocation, input.preferredHome))
        return { outcome: "stay", reason: "already_home" };
    return { outcome: "move", target: input.preferredHome, reason: "idle_return_enabled" };
}
export function decideAgentHomeEraseReceipt(request, receipt) {
    const fenceMatches = request.eraseFence.erasureId === receipt.eraseFence.erasureId
        && request.eraseFence.ownerUserId === receipt.eraseFence.ownerUserId
        && request.eraseFence.agentPrincipal === receipt.eraseFence.agentPrincipal
        && request.eraseFence.homeId === receipt.eraseFence.homeId
        && request.eraseFence.eraseEpoch === receipt.eraseFence.eraseEpoch
        && request.eraseFence.issuedAtPlatform === receipt.eraseFence.issuedAtPlatform
        && request.eraseFence.expiresAtPlatform === receipt.eraseFence.expiresAtPlatform;
    if (!fenceMatches)
        return { outcome: "refused", reason: "erase_fence_mismatch" };
    const requested = new Set(request.locations.map(locationKey));
    const receiptRequested = new Set(receipt.requestedLocations.map(locationKey));
    const covered = new Set(receipt.coveredLocations.map(locationKey));
    const reported = new Set(receipt.locations.map(({ location }) => locationKey(location)));
    const erased = new Set(receipt.locations.filter(({ state }) => state === "erased").map(({ location }) => locationKey(location)));
    const requestedMatches = receiptRequested.size === requested.size && [...requested].every((key) => receiptRequested.has(key));
    const allReported = reported.size === requested.size && [...requested].every((key) => reported.has(key));
    const coveredMatchesErased = covered.size === erased.size && [...erased].every((key) => covered.has(key));
    const completeCoverage = receipt.outcome !== "complete"
        || (covered.size === requested.size && [...requested].every((key) => covered.has(key)));
    if (!requestedMatches || !allReported || !coveredMatchesErased || !completeCoverage) {
        return { outcome: "refused", reason: "incomplete_location_coverage" };
    }
    return { outcome: "accepted", reason: "erase_fence_and_locations_match" };
}
export function decideAgentHomePostEraseAdmission(tombstone, operation) {
    return tombstone.homeId === operation.homeId
        ? { outcome: "refused", reason: "erase_tombstone_fence" }
        : { outcome: "accepted", reason: "different_home" };
}
export function decideAgentHomeRestore(tombstone, request) {
    const erased = tombstone !== null && tombstone.homeId === request.homeId;
    return erased
        ? { outcome: "refused", reason: "erased_home_cannot_resurrect" }
        : { outcome: "accepted", browserSessionsOnRestore: "excluded" };
}
function locationKey(location) {
    return location.kind === "cloud" ? "cloud" : `mac:${location.deviceServiceId}`;
}
