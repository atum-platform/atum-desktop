/**
 * The agent's Screen: a live view of the agent's own cloud browser in the side panel, with Take
 * over and Hand back and continue (plan 2026-11-28 "Agent browser the owner can watch and take
 * over", step S4; owner decisions D2-D4).
 *
 * Adapted from upstream Hermes Desktop's Bot Screen pane (`apps/desktop/src/plugins/hermes-bots/
 * screen-pane.tsx`, NousResearch/hermes-agent at 266360dd, Copyright (c) 2026 Nous Research, MIT;
 * the full notice is in connection.ts and third-party/licenses/app/hermes-desktop-bot-screen-
 * LICENSE.txt). Kept from upstream: the server owns the lease and this pane paints a cache of it;
 * the stream is its own WebSocket handed to noVNC (MPL-2.0, unmodified dependency); `viewOnly` is
 * presentation only, because the server drops input from anyone but the lease holder; the noVNC
 * client loads before dialing; a 4000 eviction re-attaches in watch mode; closing the tab hands
 * back with a clean close; paste goes through only while in control. Changed for Atum: Atum Kit,
 * one transport seam (`transport.ts`), the state in a tested reducer (`connection.ts`), no install,
 * start or image-switch flows (the managed cloud computer owns its screen), and one explicit "Hand
 * back and continue" whose message is sent once, only after the server confirms the release.
 */
import './pane.css'

import { useCallback, useEffect, useReducer, useRef } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { phosphorIcon } from '@/lib/phosphor-icon'

import { matrixAgentScreenText } from '../../../shared/matrix-agent-screen-copy'

import {
  AGENT_SCREEN_INITIAL,
  agentScreenHeldBy,
  agentScreenPhase,
  type AgentScreenProblem,
  agentScreenReduce
} from './connection'
import {
  type AgentScreenBinding,
  AgentScreenError,
  type AgentScreenTransport,
  agentScreenViewerHash
} from './transport'

const ReconnectIcon = phosphorIcon('arrows-clockwise')
const MonitorIcon = phosphorIcon('monitor')

/** The noVNC surface the pane uses. */
interface RfbLike {
  viewOnly: boolean
  scaleViewport: boolean
  resizeSession: boolean
  focusOnClick: boolean
  background: string
  qualityLevel: number
  addEventListener(type: string, handler: (event: { detail?: { clean?: boolean; reason?: string } }) => void): void
  disconnect(): void
  focus(): void
  clipboardPasteFrom(text: string): void
}

type RfbConstructor = new (target: HTMLElement, socket: WebSocket, options?: Record<string, unknown>) => RfbLike

/** The native RFB filter closes the socket on a ClientCutText over this; never send one. */
const MAX_PASTE_CUT_TEXT = 256 * 1024
/** The plan's lease status poll while the panel is open (S3). */
export const AGENT_SCREEN_STATUS_POLL_MS = 2_000

async function loadRfb(): Promise<RfbConstructor> {
  const mod = (await import('@novnc/novnc')) as unknown as { default: RfbConstructor }

  return mod.default
}

function problemOf(error: unknown): AgentScreenProblem {
  if (error instanceof AgentScreenError) {
    return error.reason === 'not_owner' ? 'owner_only' : error.reason === 'unavailable' ? 'unavailable' : 'stream_lost'
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
  /** Sends the owner's visible "carry on" message to the agent's chat. Called at most once per
   * confirmed release. */
  onContinue(text: string): void
}

export function MatrixAgentScreenPane({ active, binding, name, onContinue, transport }: MatrixAgentScreenPaneProps) {
  const { locale } = useI18n()
  const copy = matrixAgentScreenText(locale)
  const [state, dispatch] = useReducer(agentScreenReduce, AGENT_SCREEN_INITIAL)
  const stateRef = useRef(state)
  stateRef.current = state
  const phase = agentScreenPhase(state)
  const lease = state.status?.lease
  const canvasHost = useRef<HTMLDivElement | null>(null)
  const rfb = useRef<RfbLike | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const pasteCleanup = useRef<(() => void) | null>(null)
  const generation = useRef(0)
  const continued = useRef(new Set<number>())
  const { agentPrincipal, roomId } = binding

  const refresh = useCallback(async () => {
    try {
      dispatch({ type: 'status', status: await transport.status({ agentPrincipal, roomId }) })
    } catch (error) {
      dispatch({ type: 'failed', problem: problemOf(error) })
    }
  }, [agentPrincipal, roomId, transport])

  const detach = useCallback((handBack = false) => {
    generation.current += 1

    // noVNC closes without a status. Closing the tab sends 1000 first, which the native bridge
    // takes as a hand back; a reconnect's teardown keeps the lease.
    if (handBack) {
      socket.current?.close(1000)
    }

    rfb.current?.disconnect()
    rfb.current = null
    socket.current?.close()
    socket.current = null
    pasteCleanup.current?.()
    pasteCleanup.current = null
  }, [])

  const attach = useCallback(
    async (manual: boolean) => {
      detach()

      // The viewer hash needs crypto.subtle and noVNC a secure context.
      if (!globalThis.crypto?.subtle) {
        dispatch({ type: 'failed', problem: 'unavailable' })

        return
      }

      const current = generation.current
      dispatch({ type: 'attach', manual })

      try {
        const priorViewer = stateRef.current.viewer?.id
        const grant = await transport.observe({ agentPrincipal, roomId }, priorViewer ? { viewerId: priorViewer } : {})
        const viewer = { id: grant.viewerId, hash: await agentScreenViewerHash(grant.viewerId) }

        if (current !== generation.current) {
          return
        }

        dispatch({ type: 'minted', viewer, status: grant.status, at: Date.now() })

        // A transport without a stream (the mock) has nothing to dial: the screen is "live" blank.
        if (!grant.streamUrl || !canvasHost.current) {
          dispatch({ type: 'connected' })

          return
        }

        // Load the client before dialing: noVNC installs its own `onopen`.
        const Rfb = await loadRfb()

        if (current !== generation.current || !canvasHost.current) {
          return
        }

        const ws = new WebSocket(grant.streamUrl)
        ws.binaryType = 'arraybuffer'
        socket.current = ws
        // noVNC's `disconnect` carries only {clean}; the bridge's verdict is the raw close code.
        let closeCode = 0
        ws.addEventListener('close', event => {
          closeCode = event.code
        })
        const client = new Rfb(canvasHost.current, ws, { shared: true })
        client.scaleViewport = true
        client.resizeSession = false
        client.focusOnClick = true
        client.background = 'transparent'
        client.qualityLevel = 7
        client.viewOnly = !agentScreenHeldBy(grant.status.lease, viewer)
        client.addEventListener('connect', () => {
          if (current === generation.current) {
            dispatch({ type: 'connected' })
          }
        })
        client.addEventListener('disconnect', event => {
          if (rfb.current === client) {
            rfb.current = null
          }

          if (current !== generation.current) {
            return
          }

          dispatch({
            type: 'disconnected',
            code: closeCode,
            clean: Boolean(event.detail?.clean),
            reason: event.detail?.reason,
            at: Date.now()
          })
          void refresh()
        })
        rfb.current = client

        // Explicit paste only, while in control (viewOnly is read live).
        const target = canvasHost.current

        const paste = (event: ClipboardEvent) => {
          const text = event.clipboardData?.getData('text')

          if (!client.viewOnly && text && text.length <= MAX_PASTE_CUT_TEXT) {
            event.preventDefault()
            client.clipboardPasteFrom(text)
          }
        }

        target.addEventListener('paste', paste)
        pasteCleanup.current = () => target.removeEventListener('paste', paste)
      } catch (error) {
        if (current === generation.current) {
          dispatch({ type: 'failed', problem: problemOf(error) })
        }
      }
    },
    [agentPrincipal, detach, refresh, roomId, transport]
  )

  // Visibility is not lifecycle: only unmount (closing the tab) tears down, and hands back.
  useEffect(() => () => detach(true), [detach])

  useEffect(() => {
    if (!active) {
      return
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), AGENT_SCREEN_STATUS_POLL_MS)

    return () => window.clearInterval(timer)
  }, [active, refresh])

  useEffect(() => {
    if (state.status?.running && state.conn === 'idle') {
      void attach(false)
    }
  }, [attach, state.conn, state.status?.running])

  const inControl = phase === 'control'

  useEffect(() => {
    if (rfb.current) {
      rfb.current.viewOnly = !inControl

      if (inControl) {
        rfb.current.focus()
      }
    }
  }, [inControl])

  const takeOver = async () => {
    const { viewer, status } = stateRef.current

    if (!viewer || !status) {
      return
    }

    dispatch({ type: 'take' })

    try {
      const result = await transport.acquire({ agentPrincipal, roomId }, { viewerId: viewer.id, expectedEpoch: status.lease.epoch })
      dispatch({ type: 'lease', lease: result.lease })

      if (stateRef.current.conn !== 'live') {
        void attach(true)
      }
    } catch (error) {
      dispatch({ type: 'failed', problem: problemOf(error) })
      void refresh()
    }
  }

  // One explicit action (D2): release, and only when the server says this call ended this owner's
  // control does the agent get one "carry on". Force, close, eviction and reconnect never write.
  const handBack = async (force: boolean) => {
    const viewer = stateRef.current.viewer

    if (!force && !viewer) {
      return
    }

    dispatch({ type: 'hand_back' })

    try {
      const result = await transport.release(
        { agentPrincipal, roomId },
        force ? { force: true } : { viewerId: viewer!.id }
      )

      dispatch({ type: 'handed_back', lease: result.lease })

      if (!force && result.released && !continued.current.has(result.lease.epoch)) {
        continued.current.add(result.lease.epoch)
        onContinue(copy.continueMessage)
      }
    } catch (error) {
      dispatch({ type: 'failed', problem: problemOf(error) })
      void refresh()
    }
  }

  if (state.problem === 'owner_only' || state.problem === 'unavailable') {
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

  if (state.status && !state.status.running) {
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
        {phase === 'control' || phase === 'handing_back' ? (
          <button
            className="ak-btn ak-btn--sm ak-btn--primary"
            data-agent-screen-hand-back
            disabled={busy}
            onClick={() => void handBack(false)}
            type="button"
          >
            {copy.handBackContinue}
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
              disabled={busy || attaching || !state.viewer}
              onClick={() => void takeOver()}
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
      {lease && <p className="atum-screen-line">{line}</p>}
    </div>
  )
}
