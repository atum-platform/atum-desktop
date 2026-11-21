import type { WorkEnrollmentFacts, WorkGrantCarry, WorkMacEvent, WorkRefusalReason, WorkSyncAck, WorkSyncPage, WorkT3LaunchCall } from './contract'

// The seams the gate is built against. Each one is something main already has or another lane owns; the gate
// holds no implementation of them beyond the T3 and platform HTTP clients (t3-client.ts, platform.ts).

/** What a read of one T3 thread found. */
export type ThreadRead =
  | {
      kind: 'found'
      status: string
      activeRunId?: string
      runs: { runId: string; ordinal: number; status: string }[]
      raw: Record<string, unknown>
    }
  | { kind: 'absent' }
  | { kind: 'transport' }
  | { kind: 'error'; code: string }

export interface T3Reply {
  transport: 'ok' | 'failed'
  status?: number
  isError?: boolean
  data?: Record<string, unknown> | null
  /** T3's own typed code, when it gave one. */
  code?: string | null
  error?: string
}

/**
 * The read-only face of T3. The request-status path (status.ts) is built from this alone, so it can read a thread
 * and cannot start, steer or stop one: there is no method here that could.
 */
export interface T3Reader {
  read(token: string, threadId: string): Promise<ThreadRead>
}

export interface T3Port extends T3Reader {
  /** The id of the ready T3 process, or undefined while none serves. A new process has a new id. */
  incarnation(): string | undefined
  /** A digest of T3's provider and mode settings. A resend needs the same one that admission saw. */
  settingsFingerprint(): string
  /** Whether the delegated instance and its model are advertised (a fresh home advertises only `default` at first). */
  providerReady(token: string): Promise<boolean>
  /** Open this bearer's MCP session so that `launch` can start its request in the same synchronous step. */
  prepare(token: string): Promise<boolean>
  /**
   * Hand one launch to T3. The request is STARTED before this returns (the caller commits `forwarded` and calls
   * this in one synchronous section); it never retries and never re-initialises a session by itself.
   */
  launch(token: string, call: WorkT3LaunchCall, modeLimit: string): Promise<T3Reply>
  interrupt(token: string, threadId: string, options?: { stop?: boolean }): Promise<T3Reply>
  wait(token: string, threadId: string, runId: string, timeoutMs: number): Promise<T3Reply>
  list(token: string, args: { limit?: number; cursor?: string }): Promise<T3Reply>
  /** Main may restart the session server itself once none of the person's own runs is active. */
  restartWhenIdle?(): Promise<'restarted' | 'declined'>
}

export type OwnerEventOutcome =
  | { kind: 'unreachable' }
  | { kind: 'invalid'; reason: Extract<WorkRefusalReason, `owner_event_${string}`> }
  | { kind: 'ok'; body: string; originServerTs: number }

/**
 * Main's own Matrix client (K35): it fetches THAT event itself and checks that it exists and is not redacted, that
 * its sender is the signed-in owner, that its room is the owner's conversation with this agent as the account's
 * agent record gives it (never as the caller says), and, in an encrypted room, that main decrypted it and the
 * sending device is the owner's. The age bound is the gate's.
 */
export interface OwnerEventVerifier {
  fetch(input: { agentPrincipal: string; eventId: string }): Promise<OwnerEventOutcome>
}

export type ModelAccess = 'allowed' | 'empty' | 'unavailable'

export interface GateSession {
  token: string
  sessionId: string
}

/** The agents' peer-link sessions and main's owner session (plan §11.2). Tokens never leave main. */
export interface GateSessions {
  /** The agent's current session, issued when it has none. */
  agent(principal: string): Promise<GateSession>
  /** The current session's id without issuing one. */
  agentSessionId(principal: string): string | undefined
  /** Main's own session, for owed stops and reads. No gate call is ever forwarded with it. */
  owner(): Promise<GateSession>
  /** Revoke the agent's session through the running server (plan §6.4 step 3). */
  revokeAgent(principal: string): Promise<void>
  revokeAll(principals: string[]): Promise<void>
  /** Drop every session: an auth reset killed them. New ones are issued on the next use. */
  forgetAll(): void
}

export interface WorkPlatform {
  enroll(input: { deviceServiceId: string; socketPath: string; gateId: WorkEnrollmentFacts['gateId']; workGrant?: { acceptedAt: number; routeEpoch: number } }): Promise<{ work: WorkEnrollmentFacts | null }>
  pull(input: { deviceServiceId: string; accountId: string; appliedSeq: number; routeEpoch: number }): Promise<WorkSyncPage>
  ack(ack: WorkSyncAck): Promise<void>
  macEvent(event: WorkMacEvent): Promise<void>
  carryGrant(carry: WorkGrantCarry): Promise<void>
  /**
   * Content-free, request-correlated stop reports (R4-1). Optional: the platform carries them only after the
   * contract amendment in docs/self-work/slice-a/lane-g-report.md. Until then they stay queued and the helper stays
   * at `revoked`/`unknown` (R4-1: "explicitly leave the helper at unknown when no acknowledgement is reachable").
   */
  reportSettlements?(reports: StopReport[]): Promise<void>
}

/** What the platform may learn about a request that a revocation cut off. No thread, no text, no id of a thread. */
export interface StopReport {
  agentPrincipal: string
  requestId: string
  /** The route epoch and agent generation the request was admitted under: they survive the grant's death. */
  routeEpochAtAdmit: number
  agentGenerationAtAdmit: number
  scope: 'route' | 'agent'
  outcome: 'stopped' | 'never_sent' | 'nothing_started'
  revocationId: number
  settledAt: number
}
