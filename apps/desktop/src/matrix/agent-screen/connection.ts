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
 * Control comes from the controller's session-scoped status and a connected control stream.
 */
import type { AgentScreenStatus } from './transport'

const CLOSE_CONTROL_TAKEN = 4000
const EVICTION_WINDOW_MS = 10_000
const MAX_RAPID_EVICTIONS = 3

export type AgentScreenProblem = 'stream_lost' | 'control_moved' | 'unavailable' | 'owner_only'

export interface AgentScreenState {
  conn: 'idle' | 'attaching' | 'live' | 'error'
  status: AgentScreenStatus | null
  sessionId: string | undefined
  mode: 'watch' | 'control'
  handingBack: boolean
  taking: boolean
  evicted: boolean
  rapidEvictions: number
  dialedAt: number
  problem: AgentScreenProblem | null
}

export const AGENT_SCREEN_INITIAL: AgentScreenState = {
  conn: 'idle',
  status: null,
  sessionId: undefined,
  mode: 'watch',
  handingBack: false,
  taking: false,
  evicted: false,
  rapidEvictions: 0,
  dialedAt: 0,
  problem: null
}

export type AgentScreenEvent =
  | { type: 'status'; status: AgentScreenStatus }
  | { type: 'session_expired'; status: AgentScreenStatus }
  | { type: 'attach'; manual: boolean }
  | { type: 'minted'; sessionId: string; mode: 'watch' | 'control'; status: AgentScreenStatus; at: number }
  | { type: 'connected' }
  | { type: 'disconnected'; code: number; clean: boolean; at: number }
  | { type: 'take' }
  | { type: 'hand_back' }
  | { type: 'handed_back'; status: AgentScreenStatus }
  | { type: 'failed'; problem: AgentScreenProblem }

export function agentScreenInputEnabled(state: AgentScreenState): boolean {
  return state.conn === 'live' && state.mode === 'control' && state.status?.viewerHasControl === true &&
    state.status.running && !state.handingBack
}

export function agentScreenPhase(state: AgentScreenState): 'watch' | 'control' | 'handing_back' | 'other' {
  if (state.handingBack) {return 'handing_back'}
  if (state.status?.viewerHasControl) {return 'control'}

  return state.status?.holder === 'human' ? 'other' : 'watch'
}

export function agentScreenReduce(state: AgentScreenState, event: AgentScreenEvent): AgentScreenState {
  switch (event.type) {
    case 'status': {
      if (state.status && event.status.controlRevision < state.status.controlRevision) {return state}
      const recovered = state.problem === 'unavailable' || state.problem === 'owner_only'

      return {
        ...state,
        ...(recovered || !event.status.running ? { conn: 'idle' as const, problem: null } : {}),
        status: event.status
      }
    }
    case 'session_expired':
      return { ...AGENT_SCREEN_INITIAL, status: event.status }

    case 'attach':
      return {
        ...state,
        conn: 'attaching',
        problem: null,
        rapidEvictions: event.manual ? 0 : state.rapidEvictions
      }
    case 'minted':
      return { ...state, status: event.status, sessionId: event.sessionId, mode: event.mode, taking: false, dialedAt: event.at }
    case 'connected':
      return state.conn === 'attaching' ? { ...state, conn: 'live', evicted: false } : state
    case 'disconnected': {
      if (event.code === CLOSE_CONTROL_TAKEN) {
        const rapidEvictions = event.at - state.dialedAt < EVICTION_WINDOW_MS ? state.rapidEvictions + 1 : 1
        const status = state.status && { ...state.status, holder: 'human' as const, viewerHasControl: false }

        return rapidEvictions > MAX_RAPID_EVICTIONS
          ? { ...state, status, conn: 'error', evicted: false, rapidEvictions, problem: 'control_moved' }
          : { ...state, status, conn: 'idle', evicted: true, rapidEvictions }
      }

      return event.clean ? { ...state, conn: 'idle' } : { ...state, conn: 'error', problem: 'stream_lost' }
    }
    case 'take':
      return { ...state, taking: true, problem: null }
    case 'hand_back':
      return { ...state, handingBack: true, problem: null }
    case 'handed_back':
      return { ...state, status: event.status, conn: 'idle', handingBack: false, problem: null }
    case 'failed':
      return { ...state, taking: false, handingBack: false, conn: 'error', problem: event.problem }
  }
}
