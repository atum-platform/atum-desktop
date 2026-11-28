/**
 * The Screen's connection and control state, as a pure reducer.
 *
 * Adapted from upstream Hermes Desktop's Bot Screen (`apps/desktop/src/plugins/hermes-bots/
 * screen-pane.tsx` and `screen-connection.ts`, NousResearch/hermes-agent at 266360dd).
 * Copyright (c) 2026 Nous Research. MIT License: permission is hereby granted, free of charge, to
 * any person obtaining a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
 * Software, and to permit persons to whom the Software is furnished to do so, subject to the
 * following conditions: the above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 * WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. See LICENSES/Hermes-Agent-MIT.txt.
 *
 * Upstream keeps this state in component refs; here it is one reducer so the rules are tested:
 *
 * - watch → control → hand back: control only after the server granted the lease to this window's
 *   viewer; "handing back" until the server confirms the release.
 * - An evicted viewer (bridge close 4000, `control-taken`) goes back to watching on a fresh ticket.
 *   A bridge that evicts every fresh attach is bounded (three rapid evictions), then an error.
 * - A dropped stream keeps the lease and the viewer: reconnecting re-presents the same viewer id,
 *   so the owner is still in control. Only an explicit hand back (or closing the tab) releases it.
 */
import type { AgentScreenLease, AgentScreenStatus } from './transport'

/** Bridge close code when another viewer took the lease (the native display bridge). */
export const AGENT_SCREEN_CLOSE_CONTROL_TAKEN = 4000
/** Evictions this soon after dialing count toward the loop budget; slower ones reset it. */
export const AGENT_SCREEN_EVICTION_WINDOW_MS = 10_000
export const AGENT_SCREEN_MAX_RAPID_EVICTIONS = 3

export type AgentScreenConn = 'idle' | 'attaching' | 'live' | 'error'
export type AgentScreenProblem = 'stream_lost' | 'control_moved' | 'unavailable' | 'owner_only'

export interface AgentScreenViewer {
  id: string
  hash: string
}

export interface AgentScreenState {
  conn: AgentScreenConn
  status: AgentScreenStatus | null
  viewer: AgentScreenViewer | null
  /** A release is on its way; the chip says "Handing back…" until the server answers. */
  handingBack: boolean
  /** A take over is on its way. */
  taking: boolean
  /** Went back to watching after another window took control (cleared when frames arrive). */
  evicted: boolean
  rapidEvictions: number
  dialedAt: number
  problem: AgentScreenProblem | null
}

export const AGENT_SCREEN_INITIAL: AgentScreenState = {
  conn: 'idle',
  status: null,
  viewer: null,
  handingBack: false,
  taking: false,
  evicted: false,
  rapidEvictions: 0,
  dialedAt: 0,
  problem: null
}

export type AgentScreenEvent =
  | { type: 'status'; status: AgentScreenStatus }
  | { type: 'attach'; manual: boolean }
  | { type: 'minted'; viewer: AgentScreenViewer; status: AgentScreenStatus; at: number }
  | { type: 'connected' }
  | { type: 'disconnected'; code: number; clean: boolean; reason?: string; at: number }
  | { type: 'take' }
  | { type: 'lease'; lease: AgentScreenLease }
  | { type: 'hand_back' }
  | { type: 'handed_back'; lease: AgentScreenLease }
  | { type: 'failed'; problem: AgentScreenProblem }

/** Does this window's viewer hold the lease? The server names the holder by hash only. */
export function agentScreenHeldBy(lease: AgentScreenLease | null | undefined, viewer: AgentScreenViewer | null): boolean {
  return Boolean(lease && viewer && lease.holder === 'human' && lease.viewerHash === viewer.hash)
}

/** What the chip says. `other`: a human lease this window does not hold (stale or another window). */
export type AgentScreenPhase = 'watch' | 'control' | 'handing_back' | 'other'

export function agentScreenPhase(state: AgentScreenState): AgentScreenPhase {
  const lease = state.status?.lease

  if (state.handingBack) {
    return 'handing_back'
  }

  if (agentScreenHeldBy(lease, state.viewer)) {
    return 'control'
  }

  return lease?.holder === 'human' ? 'other' : 'watch'
}

function withLease(state: AgentScreenState, lease: AgentScreenLease): AgentScreenState {
  const current = state.status?.lease

  // A reply that an already-applied newer epoch overtook never repaints an older lease.
  if (current && lease.epoch < current.epoch) {
    return state
  }

  return { ...state, status: { running: state.status?.running ?? true, lease } }
}

export function agentScreenReduce(state: AgentScreenState, event: AgentScreenEvent): AgentScreenState {
  switch (event.type) {
    case 'status': {
      const next = withLease(state, event.status.lease)
      // The server answered: a screen that was unavailable (or refused) is reachable again.
      const recovered = state.problem === 'unavailable' || state.problem === 'owner_only'

      return {
        ...next,
        ...(recovered ? { conn: 'idle' as const, problem: null } : {}),
        status: { running: event.status.running, lease: next.status!.lease }
      }
    }

    case 'attach':
      return {
        ...state,
        conn: 'attaching',
        problem: null,
        rapidEvictions: event.manual ? 0 : state.rapidEvictions
      }

    case 'minted':
      return { ...withLease(state, event.status.lease), viewer: event.viewer, dialedAt: event.at }

    case 'connected':
      return state.conn === 'attaching' ? { ...state, conn: 'live', evicted: false } : state
    case 'disconnected': {
      if (event.code === AGENT_SCREEN_CLOSE_CONTROL_TAKEN || event.reason?.includes('control-taken')) {
        const rapidEvictions =
          event.at - state.dialedAt < AGENT_SCREEN_EVICTION_WINDOW_MS ? state.rapidEvictions + 1 : 1

        // Idle re-attaches in watch mode on a fresh ticket; a bridge that evicts every attach stops.
        return rapidEvictions > AGENT_SCREEN_MAX_RAPID_EVICTIONS
          ? { ...state, conn: 'error', evicted: false, rapidEvictions, problem: 'control_moved' }
          : { ...state, conn: 'idle', evicted: true, rapidEvictions }
      }

      // The lease and the viewer stay: a dropped link is not a hand back.
      return event.clean ? { ...state, conn: 'idle' } : { ...state, conn: 'error', problem: 'stream_lost' }
    }

    case 'take':
      return { ...state, taking: true, problem: null }

    case 'lease':
      return { ...withLease(state, event.lease), taking: false }

    case 'hand_back':
      return { ...state, handingBack: true, problem: null }

    case 'handed_back':
      return { ...withLease(state, event.lease), handingBack: false }

    case 'failed':
      return {
        ...state,
        taking: false,
        handingBack: false,
        conn: event.problem === 'stream_lost' || event.problem === 'owner_only' || event.problem === 'unavailable'
          ? 'error'
          : state.conn,
        problem: event.problem
      }
  }
}
