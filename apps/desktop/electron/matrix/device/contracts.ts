import type { WorkspaceManifest } from "../../../../../packages/device-protocol/workspace-messages"
/**
 * C0 device-runtime seams (S1 build plan §3.7), frozen so WS-3b, WS-4 and WS-5a build the Mac's
 * device service against one shape. Types only; no behaviour ships in C0.
 *
 * These are the device (Electron main) side. The wire message shapes live in
 * `@atum/device-protocol`; the capability unions are re-declared here so this electron project
 * stays self-contained (its composite build does not reach into `packages/`). Keep them identical
 * to `packages/device-protocol/messages.ts` — that module is the source of truth.
 */

/** Keep identical to `@atum/device-protocol` `Capability`. */
export type DeviceCapability = 'terminal' | 'files' | 'computer' | 'send_file'

/** Keep identical to `@atum/device-protocol` `ProtectedCapability`. */
export type DeviceProtectedCapability =
  | 'ssh_agent' | 'keychain' | 'browser_store' | 'cloud_cli' | 'persistence' | 'network_new_host'
  | 'sudo' | 'other_agent_write' | 'exec_downloaded' | 'bulk_destructive' | 'gui_upload'

export type DeviceTool =
  | 'terminal' | 'read_file' | 'write_file' | 'patch' | 'search_files' | 'computer_use' | 'send_file'

export type DeviceLedgerState =
  | 'not_started' | 'started' | 'completed' | 'failed_no_effect' | 'unknown' | 'refused'

/** A `TurnGrant` the device has admitted (keep identical to the wire `TurnGrant`). */
export interface DeviceGrant {
  grantId: string
  ownerUserId: string
  agentPrincipal: string
  agentUserId: string
  invocationId?: string
  occurrenceId?: string
  roomId?: string
  eventId?: string
  originKind: 'device' | 'other' | 'schedule'
  originAssertionHash: string | null
  writerEpoch: { leaseGeneration: number; leaseTokenHash: string }
  targetDeviceServiceId: string
  enrollmentEpoch: number
  accountEpoch: number
  scopes: DeviceCapability[]
  connectionId: string
  issuedAt: number
  expiresAt: number
}

/** An on-device, single-use approval record (created only on the device; never on the wire). */
export interface DeviceApproval {
  commandHash: string
  capability: DeviceProtectedCapability
  approvalHash: string
  expiresAt: number
}

/** An `Execute` that has passed the §3.3 admission order. The handler runs it under `ctx`. */
export interface VerifiedExecute {
  commandId: string
  grantId: string
  seq: number
  tool: DeviceTool
  args: Record<string, unknown>
  argsHash: string
  inputManifestHash: string | null
  needs: DeviceProtectedCapability[]
  proposedEffect: 'ordinary' | DeviceProtectedCapability
  timeoutMs: number
}

export interface DeviceArtifact {
  name: string
  size: number
  sha256: string
  path: string
}

/** A progress frame or the terminal receipt a {@link DeviceExecutor} yields for one command. */
export type ProgressOrReceipt =
  | { kind: 'progress'; commandId: string; output: string }
  | {
      kind: 'receipt'
      commandId: string
      state: DeviceLedgerState
      result?: { exitCode?: number; output?: string; data?: unknown }
      artifacts: DeviceArtifact[]
      startedAt?: number
      endedAt?: number
    }

export interface DeviceExecutorContext {
  grant: DeviceGrant
  approval?: DeviceApproval
  /** The device is paused (an approval prompt is up); the GUI broker must refuse actions. */
  paused(): boolean
  /** Aborts on Stop, sign-out, account switch, sleep, lease loss or deadline. */
  signal: AbortSignal
}

/** Runs one verified command on this Mac through Hermes's own tools (WS-4 implements it). */
export interface DeviceExecutor {
  /** Release GUI target state and driver resources when this grant ends. */
  releaseGrant?(grantId: string): void
  run(command: VerifiedExecute, context: DeviceExecutorContext): AsyncIterable<ProgressOrReceipt>
}

/** The device-local roots the profile protects (WS-4/WS-5 provide them): Drive roots are pinned in place, other agents' copies are denied. */
export interface ProtectedRoots {
  /** The Atum Drive root on this Mac, or null when Drive is not mounted. */
  driveRoot(): string | null
  /** All known synced roots, including disconnected accounts. Never forget a pin. */
  driveRoots(): string[]
  /**
   * The roots a command may WRITE: the current account's Drive, re-verified on every call (same
   * directory as when learned, not a link, carries the engine's binding marker). Empty when Drive
   * is signed out, switched or its folder was swapped. Every other learned root is deny-only.
   */
  writableDriveRoots(): string[]
  /** Other agents' task working copies, which this agent may not write. */
  agentWorkingRoots(): string[]
}

/** A per-task Drive working copy on the device (WS-5a implements it; WS-4's `service.ts` takes it
 * as an optional constructor dependency). */
export interface WorkspaceCopies {
  /** `withheld`: changed files kept out of `changed` because their Drive twin changed under the copy (unpublished work). */
  changes?(grantId: string): Promise<{ changed: string[]; deleted: string[]; withheld?: string[] }>
  /**
   * A last look at the Drive twins, to call just before each file's bytes are sent: of the copy
   * paths given, the ones to keep back now. Stays usable after `end(grantId)`; null without a copy.
   */
  publicationGuard?(grantId: string): ((paths: string[]) => Promise<string[]>) | null
  manifest?(grantId: string): WorkspaceManifest | null
  end?(grantId: string): void
  release?(artifacts: DeviceArtifact[]): Promise<void>
  prepare(grant: DeviceGrant): Promise<{ cwd: string; manifest: string }>
  collect(paths: string[]): Promise<DeviceArtifact[]>
  refresh(): Promise<string | null>
  driveRoots(): string[]
  writableDriveRoots?(): string[]
  agentWorkingRoots(): string[]
  ownWorkingRoot(grantId: string): Promise<string | null>
}
