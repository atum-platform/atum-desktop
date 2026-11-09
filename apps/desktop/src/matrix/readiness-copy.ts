import type { MatrixReadiness, MatrixSnapshot } from '../../shared/matrix'

/** The copy keys this module reads; the full catalog is `t.matrixShell`. */
export interface MatrixReadinessShellCopy {
  startupAssistant: string
  startupModel: string
  startupHermes: string
  startupAi: string
  startupAuthority: string
  startupConnectTitle: string
  startupAssistantFailed: string
  startupModelFailed: string
  startupFailedHelp: string
  readinessOffline: string
  readinessAiUnavailable: string
  readinessOutOfProtons: string
  readinessSignIn: string
  readinessPlatform: string
  readinessAssistant: string
  readinessChat: string
  readinessRuntime: string
  readinessAuthorityWithdrawn: string
  readinessAuthorityWithdrawnHelp: string
  readinessOutOfProtonsHelp: string
  readinessSetupWaiting: string
  readinessSetupWaitingHelp: string
  readinessSetupWaitingUntil: string
  /** Plainer launch words (launch-copy.ts) where a caller has them; the catalog's otherwise. */
  aiDownTitle?: string
  aiDownHelp?: string
  chatDownTitle?: string
  signedOutTitle?: string
  chatDownHelp?: string
  runtimeTitle?: string
  runtimeHelp?: string
  trustTitle?: string
  trustHelp?: string
  /** An agent whose identity is not made yet (`agent_initializing`): still being set up. */
  initializingTitle?: string
  initializingHelp?: string
  /** An agent's executor being replaced on this Mac (agent-reenroll.ts). */
  reconnectingTitle?: string
  reconnectingHelp?: string
  /** One that needs the person's Reconnect. */
  reconnectTitle?: string
  reconnectHelp?: string
  /** This Mac's own device lost its keys: only signing in again mends it. */
  deviceDamagedTitle?: string
  deviceDamagedHelp?: string
  /** A withdrawn executor's help when Reconnect is on offer. */
  withdrawnHelp?: string
  /** The person's own ChatGPT plan has no usable native connection (`plan_sign_in`). */
  planSignInTitle?: string
  planSignInHelp?: string
}

/**
 * The one action that helps: Try again (`retry`), the one-click Atum account connection
 * (`connect`), topping up (`top_up`), signing in again (`sign_in`), or a fresh install
 * (`download`, the bundled runtime is chosen once at start and only a new install mends it);
 * replacing one agent's executor on this Mac (`reconnect`, agent-reenroll.ts); or a new device
 * for this Mac, signing out and in again with the recovery key kept (`sign_in_again`); or
 * signing in to the person's own plan again in the account dialog (`plan_sign_in`).
 */
export type MatrixReadinessAction =
  | 'connect'
  | 'retry'
  | 'top_up'
  | 'sign_in'
  | 'download'
  | 'reconnect'
  | 'sign_in_again'
  | 'plan_sign_in'

/** Only a native assistant-setup cooldown can release the ready human shell.
 * Missing/invalid metadata, crypto failures and other starting steps stay gated. */
export function matrixSetupCooldown(readiness: MatrixReadiness | undefined): number | undefined {
  return readiness?.phase === 'starting' &&
    readiness.step === 'assistant' &&
    readiness.code === 'rate_limited' &&
    typeof readiness.retryAt === 'number' &&
    Number.isSafeInteger(readiness.retryAt) &&
    readiness.retryAt > 0 &&
    readiness.retryAt <= 8_640_000_000_000_000
    ? readiness.retryAt
    : undefined
}

/**
 * Plain words for a readiness state (plan 2026-09-26-reliable-local-first-chat §4.5–4.6):
 * the step being checked while starting, the reason while blocked or degraded, and the
 * one action that helps. Never a raw code or the runtime's name.
 */
export function matrixReadinessCopy(
  readiness: MatrixReadiness,
  startup: MatrixSnapshot['startup'],
  shell: MatrixReadinessShellCopy,
  opening: string,
  locale = 'en'
): { title: string; help?: string; action?: MatrixReadinessAction } {
  const retryAt = matrixSetupCooldown(readiness)

  if (retryAt !== undefined) {
    const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(retryAt)

    return {
      title: shell.readinessSetupWaiting,
      help: `${shell.readinessSetupWaitingUntil.replace('{time}', time)} ${shell.readinessSetupWaitingHelp}`
    }
  }

  if (readiness.phase === 'starting' || readiness.phase === 'ready') {
    const title = {
      signed_in: opening,
      assistant: startup?.step === 'model' ? shell.startupModel : shell.startupAssistant,
      hermes: shell.startupHermes,
      ai: shell.startupAi,
      authority: shell.startupAuthority
    }[readiness.step ?? 'signed_in']

    return { title }
  }

  switch (readiness.code) {
    // Signing in normally brings the Atum account along (account.ts): this is the rare
    // trip that did not finish, so it is one sentence and Try again.
    case 'action_required':
      return { title: shell.startupConnectTitle, action: 'connect' }

    // The assistant answers with the person's ChatGPT plan and its sign-in ended: that sign-in,
    // never a bare "not ready" or a Try again that cannot help.
    case 'plan_sign_in':
      return {
        title: shell.planSignInTitle ?? shell.startupModelFailed,
        help: shell.planSignInHelp,
        action: 'plan_sign_in'
      }

    case 'setup_failed':
      return {
        title: startup?.step === 'model' ? shell.startupModelFailed : shell.startupAssistantFailed,
        help: shell.startupFailedHelp,
        action: 'retry'
      }

    case 'offline':
      return { title: shell.readinessOffline, action: 'retry' }

    case 'out_of_protons':
      return { title: shell.readinessOutOfProtons, help: shell.readinessOutOfProtonsHelp, action: 'top_up' }

    case 'sign_in_required':

    case 'signed_out':
      return shell.signedOutTitle
        ? { title: shell.signedOutTitle, help: shell.readinessSignIn, action: 'sign_in' }
        : { title: shell.readinessSignIn, action: 'sign_in' }

    case 'platform_unavailable':
      return { title: shell.readinessPlatform, action: 'retry' }

    // Not a dead end (2026-10-05): Reconnect asks the platform for a new executor here, and the
    // platform still decides.
    case 'authority_withdrawn':
      return shell.withdrawnHelp
        ? { title: shell.readinessAuthorityWithdrawn, help: shell.withdrawnHelp, action: 'reconnect' }
        : { title: shell.readinessAuthorityWithdrawn, help: shell.readinessAuthorityWithdrawnHelp }

    // Its executor is being replaced here (its device lost its keys): progress, not a failure.
    case 'agent_reconnecting':
      return { title: shell.reconnectingTitle ?? shell.readinessAssistant, help: shell.reconnectingHelp }

    case 'agent_reconnect_required':
      return { title: shell.reconnectTitle ?? shell.readinessAssistant, help: shell.reconnectHelp, action: 'reconnect' }

    // This Mac's own device lost its keys (usually a full disk): a new sign-in mends it, and the
    // recovery key kept here unlocks it by itself.
    case 'device_replaced':
      return shell.deviceDamagedTitle
        ? { title: shell.deviceDamagedTitle, help: shell.deviceDamagedHelp, action: 'sign_in_again' }
        : { title: shell.readinessAssistant, action: 'sign_in_again' }

    case 'chat_unreachable':

    case 'chat_unavailable':
      return shell.chatDownTitle
        ? { title: shell.chatDownTitle, help: shell.chatDownHelp, action: 'retry' }
        : { title: shell.readinessChat, action: 'retry' }

    case 'ai_unavailable':
      return shell.aiDownTitle
        ? { title: shell.aiDownTitle, help: shell.aiDownHelp, action: 'retry' }
        : { title: shell.readinessAiUnavailable, action: 'retry' }

    // Verifying the assistant's own device did not finish (agent-trust.ts); the person's
    // recovery key is a separate step (`recovery_required`), so this is Try again.
    case 'agent_trust_failed':
      return shell.trustTitle
        ? { title: shell.trustTitle, help: shell.trustHelp, action: 'retry' }
        : { title: shell.readinessAssistant, action: 'retry' }

    // Its identity is not made yet (agent-trust.ts `matrix_agent_initialization_pending`): it is
    // still being set up and the gate keeps retrying, so plain words, never a security failure.
    case 'agent_initializing':
      return { title: shell.initializingTitle ?? shell.startupAssistant, help: shell.initializingHelp, action: 'retry' }

    // The assistant list lives on Atum's servers: not reaching it is not this Mac's fault.
    case 'agent_roster_unavailable':
      return { title: shell.readinessPlatform, action: 'retry' }

    // The bundled runtime is chosen once at start: only a fresh install mends it, so the one
    // action is getting the latest Atum, never a retry that pretends otherwise.
    case 'runtime_invalid':

    case 'runtime_unavailable':
      return shell.runtimeTitle
        ? { title: shell.runtimeTitle, help: shell.runtimeHelp, action: 'download' }
        : { title: shell.readinessRuntime, action: 'download' }

    default:
      return { title: shell.readinessAssistant, action: 'retry' }
  }
}
