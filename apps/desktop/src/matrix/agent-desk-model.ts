import type {
  MatrixAgentView,
  MatrixHermesPrompt,
  MatrixLocalTurnView,
  MatrixMessage,
  MatrixRoom,
  MatrixSnapshot
} from '../../shared/matrix'
import type { MatrixReachMac } from '../../shared/matrix-agent-sources'
import { matrixWorkingLine } from '../../shared/matrix-transient-lines'

import { matrixAgentTyping } from './local-turns'

/**
 * The agent's desk (plan "The agent's side panel, rebuilt for cloud-only", slice P1): what the
 * side panel's own tab says about the agent of this chat, read only from what the window already
 * receives. Presentation only: nothing here is execution authority, and Now never disagrees with
 * the chat, because it reads the chat's own signals (typing, the turn's working line, its open
 * asks, the stop target).
 */

/** The owner's agent whose own 1:1 chat this is; a group, a company room or an app chat has none. */
export function matrixAgentDeskAgent(
  snapshot: MatrixSnapshot,
  room: MatrixRoom | undefined
): MatrixAgentView | undefined {
  if (
    !room?.assistant ||
    !room.agentPrincipal ||
    room.companyChannel ||
    room.companyConversation ||
    room.companyPrivateCos ||
    room.companyPrivateCosClaim ||
    room.appBot
  ) {
    return undefined
  }

  return snapshot.agents?.find(agent => agent.principal === room.agentPrincipal)
}

export interface MatrixProgressStep {
  done: boolean
  text: string
}

const STEP_MARK = /^[✓✔•◦]/u

/**
 * A working line's words: its first line is what it is doing, the rest its steps (✓ done). A
 * native Hermes todo list (the presentation plugin's `post_tool_call` hook) has only marked
 * lines: then every line is a step and there is no headline.
 */
export function matrixProgressLineParts(body: string | undefined): { current?: string; steps: MatrixProgressStep[] } {
  const lines =
    body
      ?.split('\n')
      .map(value => value.trim())
      .filter(Boolean) ?? []

  const headed = lines[0] !== undefined && !STEP_MARK.test(lines[0])

  return {
    ...(headed ? { current: lines[0] } : {}),
    steps: lines
      .slice(headed ? 1 : 0)
      .map(value => ({ done: /^[✓✔]/u.test(value), text: value.replace(/^[✓✔•◦]\s*/u, '') }))
  }
}

export type MatrixAgentDeskNow =
  | { state: 'free' }
  /** `scheduled`: a native cron turn (its progress marker says `trigger: 'cron'`), a routine. */
  | { state: 'working'; since?: number; line?: string; steps: MatrixProgressStep[]; scheduled?: true }
  /**
   * The ask is the chat's own (one object): answering either clears both. With no prompts it is
   * the native turn's own wait (its progress marker in phase `waiting`, e.g. "Waiting for your
   * OK…" while Touch ID or an approval is pending), told in its `line`.
   */
  | { state: 'waiting'; since?: number; line?: string; prompts: readonly MatrixHermesPrompt[] }
  /** Reach-down: it is using one of the owner's devices. `device` absent means this Mac, unnamed. */
  | { state: 'device'; device?: string; since?: number; line?: string; steps: MatrixProgressStep[] }

export interface MatrixAgentDeskNowInput {
  roomId: string
  /** The agent's Matrix user. */
  agentId?: string
  messages: readonly MatrixMessage[]
  typing?: readonly string[]
  turns?: readonly MatrixLocalTurnView[]
  /** This room's own local run (a Mac-run agent). */
  running?: boolean
  /** Its open asks in this room (`agentTurns[].prompts`). */
  prompts?: readonly MatrixHermesPrompt[]
  /** Stop names a question: a cloud turn is still answering it. */
  stopTarget?: string
  /** A reach-down shell of this room is open on this Mac. */
  terminalOpen?: boolean
}

const WORKING_TURN: ReadonlySet<MatrixLocalTurnView['state']> = new Set(['waiting', 'running', 'handed_off'])

/** When the work now running began: the question it answers, else the oldest live turn, else its line. */
function workingSince(input: MatrixAgentDeskNowInput, line: MatrixMessage | undefined): number | undefined {
  const asked = input.stopTarget
    ? input.messages.find(message => message.id === input.stopTarget)?.timestamp
    : undefined

  const turn = input.turns
    ?.filter(each => each.roomId === input.roomId && WORKING_TURN.has(each.state) && !each.answer)
    .reduce<number | undefined>(
      (oldest, each) => (oldest === undefined || each.createdAt < oldest ? each.createdAt : oldest),
      undefined
    )

  return asked ?? turn ?? line?.timestamp
}

/**
 * Now: one of Free, Working, Waiting for you or On your device. An open ask wins (the agent
 * cannot move without the person); then a device it is using (its working line names the device,
 * or its shell is open here); then any sign of work. Otherwise it is free.
 */
export function matrixAgentDeskNow(input: MatrixAgentDeskNowInput): MatrixAgentDeskNow {
  const agents = new Set(input.agentId ? [input.agentId] : [])
  const line = input.agentId ? matrixWorkingLine(input.messages, agents, input.agentId) : undefined

  const working =
    Boolean(input.stopTarget) ||
    Boolean(line) ||
    matrixAgentTyping({
      roomId: input.roomId,
      agentId: input.agentId,
      typing: input.typing,
      turns: input.turns,
      running: input.running
    })

  const since = workingSince(input, line)

  if (input.prompts?.length) {
    return { state: 'waiting', ...(since !== undefined ? { since } : {}), prompts: input.prompts }
  }

  // A heartbeat only says how long it has been: the head already does.
  const parts = matrixProgressLineParts(line?.progress?.kind === 'heartbeat' ? undefined : line?.body)
  const words = { ...(parts.current ? { line: parts.current } : {}), steps: parts.steps }

  // The native turn is waiting on the owner (presentation `pre_approval_request`): its own words.
  if (line?.progress?.phase === 'waiting') {
    return {
      state: 'waiting',
      ...(since !== undefined ? { since } : {}),
      ...(parts.current ? { line: parts.current } : {}),
      prompts: []
    }
  }

  const onDevice = line?.progress && (line.progress.kind === 'device' || line.progress.kind === 'touch_id')

  if (onDevice || (working && input.terminalOpen)) {
    return {
      state: 'device',
      ...(line?.progress?.device ? { device: line.progress.device } : {}),
      ...(since !== undefined ? { since } : {}),
      ...words
    }
  }

  if (working) {
    const scheduled = line?.progress && 'trigger' in line.progress && line.progress.trigger === 'cron'

    return {
      state: 'working',
      ...(since !== undefined ? { since } : {}),
      ...words,
      ...(scheduled ? { scheduled: true as const } : {})
    }
  }

  return { state: 'free' }
}

/**
 * A message typed now changes what it is doing: a Mac-run agent's own run, or a native Hermes
 * agent in the cloud, whose gateway handles a message that arrives during a turn with
 * `busy_input_mode` (default `interrupt`, gateway/run.py). The old cloud path queued it instead.
 */
export function matrixAgentDeskSteers(input: { runtime?: MatrixAgentView['runtime']; running: boolean }): boolean {
  return input.running || input.runtime === 'hermes'
}

/** How many files the desk's Files section shows at rest. */
export const MATRIX_AGENT_DESK_FILES_MAX = 4

/**
 * The files the agent itself sent in this chat (native Hermes sends a file as a Matrix file
 * event), newest first. Only the agent's own, readable, live events: never the owner's, never a
 * stranger's, never a redacted or undecryptable one.
 */
export function matrixAgentDeskSentFiles(messages: readonly MatrixMessage[], agentId: string | undefined): MatrixMessage[] {
  if (!agentId) {
    return []
  }

  const files: MatrixMessage[] = []

  for (let index = messages.length - 1; index >= 0 && files.length < MATRIX_AGENT_DESK_FILES_MAX; index--) {
    const message = messages[index]!

    if (
      message.attachment &&
      message.sender === agentId &&
      !message.own &&
      !message.redacted &&
      !message.decryptionFailed &&
      !message.pending &&
      !message.failed
    ) {
      files.push(message)
    }
  }

  return files
}

/** Whole minutes since `since`, or nothing under one (the head then says only the state). */
export function matrixAgentDeskMinutes(since: number | undefined, now: number): number | undefined {
  if (since === undefined || !Number.isFinite(since) || now - since < 60_000) {
    return undefined
  }

  return Math.floor((now - since) / 60_000)
}

/**
 * The owner's devices as the desk lists them: the one the agent is using first (it moves up
 * under Now), then this Mac, then the others by name. A device in use is matched by the name
 * its working line gives, or is this Mac when only this Mac's shell says so.
 */
export function matrixAgentDeskDevices(
  macs: readonly MatrixReachMac[],
  now: MatrixAgentDeskNow
): { mac: MatrixReachMac; inUse: boolean }[] {
  const using =
    now.state === 'device'
      ? ((now.device ? macs.find(mac => mac.name === now.device) : undefined) ??
        (now.device ? undefined : macs.find(mac => mac.thisMac)))
      : undefined

  return [...macs]
    .sort(
      (a, b) =>
        Number(b === using) - Number(a === using) ||
        Number(b.thisMac) - Number(a.thisMac) ||
        a.name.localeCompare(b.name)
    )
    .map(mac => ({ mac, inUse: mac === using }))
}
