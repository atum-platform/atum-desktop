/**
 * The agent's Screen: a live view of the agent's own cloud browser in the side panel, with Take
 * over and Hand back and continue (plan 2026-11-28 "Agent browser the owner can watch and take
 * over", step S4; owner decisions D2-D4).
 *
 * Adapted from upstream Hermes Desktop's Bot Screen pane (`apps/desktop/src/plugins/hermes-bots/
 * screen-pane.tsx`, NousResearch/hermes-agent at 266360dd, Copyright (c) 2026 Nous Research, MIT;
 * the full notice is in connection.ts and third-party/licenses/app/hermes-desktop-bot-screen-
 * LICENSE.txt). Kept from upstream: the server owns the lease and this pane paints a cache of it;
 * the RFB stream uses a raw channel handed to noVNC (MPL-2.0, unmodified dependency); `viewOnly` is
 * presentation only, because the server drops input from anyone but the lease holder; the noVNC
 * client loads before dialing; a 4000 eviction re-attaches in watch mode; closing the tab hands
 * back with a clean close; paste goes through only while in control. Changed for Atum: Atum Kit,
 * one transport seam (`transport.ts`), the state in a tested reducer (`connection.ts`), no install,
 * start or image-switch flows (the managed cloud computer owns its screen), and one explicit "Hand
 * back and continue" whose message is sent once, only after the server confirms the release.
 */
import './pane.css'

import type RFB from '@novnc/novnc'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { phosphorIcon } from '@/lib/phosphor-icon'

import { matrixAgentScreenText } from '../../../shared/matrix-agent-screen-copy'

import {
  AGENT_SCREEN_INITIAL,
  agentScreenInputEnabled,
  agentScreenPhase,
  type AgentScreenProblem,
  agentScreenReduce
} from './connection'
import {
  type AgentScreenBinding,
  type AgentScreenChannel,
  type AgentScreenControl,
  AgentScreenError,
  type AgentScreenTransport
} from './transport'

const ReconnectIcon = phosphorIcon('arrows-clockwise')
const MonitorIcon = phosphorIcon('monitor')

/** The native RFB filter closes the socket on a ClientCutText over this; never send one. */
const MAX_PASTE_CUT_TEXT = 256 * 1024
/** The plan's lease status poll while the panel is open (S3). */
export const AGENT_SCREEN_STATUS_POLL_MS = 2_000

function problemOf(error: unknown): AgentScreenProblem {
  if (error instanceof AgentScreenError) {
    return error.reason === 'forbidden' ? 'owner_only' : error.reason === 'unavailable' ? 'unavailable' : 'stream_lost'
  }

  return 'stream_lost'
}

export interface MatrixAgentScreenPaneProps {
  binding: AgentScreenBinding
  /** The agent's name as the roster shows it. */
  name: string
  transport: AgentScreenTransport
  /** The tab is on screen (polling runs only then; the stream stays attached while hidden). */
  active: boolean
  /** The current agent ask in this private room, when one can be identified. */
  askEventId?: string
}

export function MatrixAgentScreenPane({ active, askEventId, binding, name, transport }: MatrixAgentScreenPaneProps) {
  const { locale } = useI18n()
  const copy = matrixAgentScreenText(locale)
  const [state, dispatch] = useReducer(agentScreenReduce, AGENT_SCREEN_INITIAL)
  const [refusedAsk, setRefusedAsk] = useState<string>()
  const [handbackRetry, setHandbackRetry] = useState<(AgentScreenControl & { askEventId: string }) | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const phase = agentScreenPhase(state)
  const currentAsk = askEventId !== refusedAsk ? askEventId : undefined
  const canvasHost = useRef<HTMLDivElement | null>(null)
  const rfb = useRef<RFB | null>(null)
  const socket = useRef<AgentScreenChannel | null>(null)
  const pasteCleanup = useRef<(() => void) | null>(null)
  const generation = useRef(0)
  const polling = useRef<Promise<void> | null>(null)
  const operating = useRef(false)
  const { agentPrincipal, roomId } = binding

  const detach = useCallback((handBack = false) => {
    generation.current += 1
    socket.current?.close(handBack)
    rfb.current?.disconnect()
    rfb.current = null
    socket.current = null
    pasteCleanup.current?.()
    pasteCleanup.current = null
  }, [])

  const refresh = useCallback(() => {
    if (operating.current || polling.current) {return}
    const current = generation.current
    const sessionId = stateRef.current.sessionId
    const target = { agentPrincipal, roomId }

    const poll = async () => {
      try {
        let status
        try {
          status = await transport.status(target, sessionId)
        } catch (error) {
          if (current !== generation.current) {return}
          if (!sessionId || problemOf(error) !== 'owner_only') {throw error}

          // A controller restart can retire the session while the owner still has access.
          status = await transport.status(target)
          if (current === generation.current && !operating.current) {
            detach()
            dispatch({ type: 'session_expired', status })
          }

          return
        }

        if (current === generation.current) {dispatch({ type: 'status', status })}
      } catch (error) {
        if (current !== generation.current) {return}
        // A concurrent caller can temporarily occupy the controller. Keep the last good screen.
        if (!stateRef.current.status || problemOf(error) === 'owner_only') {
          dispatch({ type: 'failed', problem: problemOf(error) })
        }
      }
    }

    polling.current = poll().finally(() => {polling.current = null})
  }, [agentPrincipal, detach, roomId, transport])

  const attach = useCallback(async (manual: boolean, take = false) => {
    if (operating.current) {return}
    operating.current = true
    detach()
    const current = generation.current
    dispatch({ type: 'attach', manual })
    if (take) {dispatch({ type: 'take' })}

    try {
      await polling.current
      if (current !== generation.current) {return}
      const { sessionId, status, evicted } = stateRef.current
      const target = { agentPrincipal, roomId }
      const grant = sessionId && status && (take || (status.viewerHasControl && !evicted))
        ? await transport.acquire(target, { sessionId, expectedControlRevision: status.controlRevision })
        : await transport.observe(target, sessionId)

      if (current !== generation.current) {return}

      dispatch({ type: 'minted', sessionId: grant.viewer.sessionId, mode: grant.viewer.mode, status: grant.status, at: Date.now() })
      const { default: Rfb } = await import('@novnc/novnc')
      if (current !== generation.current || !canvasHost.current) {return}

      const channel = transport.connect(grant.viewer.ticket)
      if (!channel) {
        dispatch({ type: 'connected' })

        return
      }

      socket.current = channel
      const client = new Rfb(canvasHost.current, channel, { shared: true })
      client.scaleViewport = true
      client.resizeSession = false
      client.focusOnClick = true
      client.background = 'transparent'
      client.qualityLevel = 7
      client.viewOnly = true
      client.addEventListener('connect', () => {
        if (current === generation.current) {dispatch({ type: 'connected' })}
      })

      // noVNC only exposes clean/unclean. The tunnel's raw close code identifies eviction.
      const rfbClose = channel.onclose
      channel.onclose = event => {
        rfbClose?.(event)
        if (current !== generation.current) {return}
        rfb.current = null
        dispatch({ type: 'disconnected', code: event.code, clean: event.wasClean, at: Date.now() })
        refresh()
      }
      rfb.current = client

      const targetNode = canvasHost.current
      const paste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData('text')
        if (!client.viewOnly && text && new TextEncoder().encode(text).byteLength <= MAX_PASTE_CUT_TEXT) {
          event.preventDefault()
          client.clipboardPasteFrom(text)
        }
      }
      targetNode.addEventListener('paste', paste)
      pasteCleanup.current = () => targetNode.removeEventListener('paste', paste)
    } catch (error) {
      if (current === generation.current) {dispatch({ type: 'failed', problem: problemOf(error) })}
    } finally {
      operating.current = false
    }
  }, [agentPrincipal, detach, refresh, roomId, transport])

  // Unmount closes the stream cleanly. Only the explicit handback operation can send a message.
  useEffect(() => () => detach(true), [detach])

  useEffect(() => {
    if (!active) {return}

    refresh()
    const timer = window.setInterval(refresh, AGENT_SCREEN_STATUS_POLL_MS)

    return () => window.clearInterval(timer)
  }, [active, refresh])

  useEffect(() => {
    if (state.status?.running === false) {detach()}
    if (active && state.status?.running && state.conn === 'idle') {void attach(false)}
  }, [active, attach, detach, state.conn, state.status?.running])

  const inControl = agentScreenInputEnabled(state)
  useEffect(() => {
    if (rfb.current) {
      rfb.current.viewOnly = !inControl
      if (inControl) {rfb.current.focus()}
    }
  }, [inControl])

  const handBack = async (force: boolean) => {
    const { sessionId, status } = stateRef.current
    if (!status || (!sessionId && !force && !handbackRetry) || operating.current) {return}
    const target = { agentPrincipal, roomId }
    const control = { sessionId: sessionId ?? '', expectedControlRevision: status.controlRevision }
    const continuation = force ? null : handbackRetry ?? (currentAsk ? { ...control, askEventId: currentAsk } : null)
    operating.current = true
    dispatch({ type: 'hand_back' })
    if (rfb.current) {rfb.current.viewOnly = true}
    if (continuation) {setHandbackRetry(continuation)}

    try {
      await polling.current
      const result = force ? await transport.forceRelease(target, status.controlRevision) :
        continuation ? await transport.handback(target, continuation) : await transport.release(target, control)
      if (result.released) {
        setHandbackRetry(null)
        detach()
        dispatch({ type: 'handed_back', status: result.status })
      }
    } catch (error) {
      // A lost handback response or failed Matrix send can be retried with the same journal key.
      if (continuation && error instanceof AgentScreenError && error.reason !== 'unavailable') {
        setHandbackRetry(null)
        if (error.reason === 'forbidden') {setRefusedAsk(continuation.askEventId)}
      }
      dispatch({ type: 'failed', problem: continuation ? 'stream_lost' : problemOf(error) })
    } finally {
      operating.current = false
      refresh()
    }
  }

  if (!handbackRetry && (state.problem === 'owner_only' || state.problem === 'unavailable')) {
    return (
      <div className="atum-screen atum-screen--state" data-agent-screen="problem">
        <div className="ak-state" role="status">
          <span className="ak-state-mark">
            <MonitorIcon aria-hidden className="ak-icon" />
          </span>
          <p className="ak-state-title">{state.problem === 'owner_only' ? copy.ownerOnly : copy.unavailable}</p>
        </div>
      </div>
    )
  }

  if (!handbackRetry && state.status && !state.status.running) {
    return (
      <div className="atum-screen atum-screen--state" data-agent-screen="idle">
        <div className="ak-state" role="status">
          <span className="ak-state-mark">
            <MonitorIcon aria-hidden className="ak-icon" />
          </span>
          <p className="ak-state-body">{copy.idle(name)}</p>
        </div>
      </div>
    )
  }

  const chip =
    phase === 'control'
      ? copy.youControl
      : phase === 'handing_back'
        ? copy.handingBack
        : phase === 'other'
          ? copy.elsewhere
          : copy.agentUsing(name)

  const line = state.evicted
    ? copy.controlMoved
    : phase === 'other'
      ? copy.handBackForceHint
      : phase === 'watch'
        ? copy.watchLine(name)
        : copy.controlLine(name)

  const attaching = state.conn === 'attaching'
  const busy = state.taking || state.handingBack

  return (
    <div className="atum-screen" data-agent-screen={phase}>
      <div className="atum-screen-bar">
        <span className="atum-screen-chip" data-agent-screen-chip role="status">
          <span aria-hidden className="ak-dot atum-screen-dot" data-on={inControl || undefined} />
          {chip}
        </span>
        <span className="flex-1" />
        {phase === 'control' || phase === 'handing_back' || handbackRetry ? (
          <button
            className="ak-btn ak-btn--sm ak-btn--primary"
            data-agent-screen-hand-back
            disabled={busy}
            onClick={() => void handBack(false)}
            type="button"
          >
            {handbackRetry || currentAsk ? copy.handBackContinue : copy.handBack}
          </button>
        ) : (
          <>
            {phase === 'other' && (
              <Tip label={copy.handBackForceHint}>
                <button
                  className="ak-btn ak-btn--sm"
                  data-agent-screen-force
                  disabled={busy}
                  onClick={() => void handBack(true)}
                  type="button"
                >
                  {copy.handBackForce}
                </button>
              </Tip>
            )}
            <button
              className="ak-btn ak-btn--sm ak-btn--primary"
              data-agent-screen-take-over
              disabled={busy || attaching || !state.sessionId}
              onClick={() => void attach(true, true)}
              type="button"
            >
              {copy.takeOver}
            </button>
          </>
        )}
        <Tip label={copy.reconnect}>
          <button
            aria-label={copy.reconnect}
            className="ak-iconbtn ak-iconbtn--sm"
            data-agent-screen-reconnect
            disabled={attaching}
            onClick={() => void attach(true)}
            type="button"
          >
            <ReconnectIcon aria-hidden className="ak-icon ak-icon--sm" />
          </button>
        </Tip>
      </div>
      <div className="atum-screen-stage" data-control={inControl || undefined}>
        {/* data-terminal: the app's type-to-focus and bare-key shortcuts leave these keys alone.
            data-remote-screen: ⌘W belongs to the remote screen, not a local tab. */}
        <div className="atum-screen-canvas" data-agent-screen-canvas data-remote-screen="" data-terminal="" ref={canvasHost} />
        {(attaching || !state.status) && state.conn !== 'error' && (
          <div className="atum-screen-overlay" role="status">
            <span aria-hidden className="ak-spinner" />
            {copy.connecting}
          </div>
        )}
        {state.conn === 'error' && (
          <div className="atum-screen-overlay atum-screen-overlay--solid">
            <div className="ak-state" role="alert">
              <p className="ak-state-title">{state.problem === 'control_moved' ? copy.controlMoved : copy.streamLost}</p>
              <button className="ak-btn ak-btn--sm" data-agent-screen-retry onClick={() => void attach(true)} type="button">
                {copy.reconnect}
              </button>
            </div>
          </div>
        )}
      </div>
      {state.status && <p className="atum-screen-line">{line}</p>}
    </div>
  )
}
