import { useEffect, useState } from 'react'

import type { MatrixMessage } from '../../../shared/matrix'

import { type AgentScreenBinding, AgentScreenError, type AgentScreenStatus, type AgentScreenTransport } from './transport'

const CLOUD_STATUS_POLL_MS = 3_000

/** One authenticated probe per room on entry, then follow display.status while a turn works. */
function watchAgentScreenStatus(
  transport: AgentScreenTransport,
  binding: AgentScreenBinding,
  follow: boolean,
  receive: (status: AgentScreenStatus | null, refused?: boolean) => void
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const probe = async () => {
    let running = false
    try {
      const status = await transport.status(binding)
      if (stopped) {return}
      running = status.running
      receive(status)
    } catch (error) {
      if (stopped) {return}
      const refused = error instanceof AgentScreenError && error.reason === 'forbidden'
      receive(null, refused)
    }

    if (follow && !running) {
      timer = setTimeout(() => void probe(), CLOUD_STATUS_POLL_MS)
    }
  }

  void probe()

  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

interface ScreenProbe {
  scope: string
  run: string | undefined
  available: boolean
  running: boolean
}

export function useAgentScreenStatus(
  transport: AgentScreenTransport | null,
  scope: string | undefined,
  roomId: string | undefined,
  agentPrincipal: string | undefined,
  run: string | undefined
): { available: boolean; running: boolean } {
  const [probe, setProbe] = useState<ScreenProbe | null>(null)

  useEffect(() => {
    if (!transport || !scope || !roomId || !agentPrincipal) {return}

    return watchAgentScreenStatus(transport, { roomId, agentPrincipal }, run !== undefined, (status, refused) => {
      setProbe(previous => ({
        scope,
        run,
        available: Boolean(status || (!refused && previous?.scope === scope && previous.available)),
        running: status?.running === true
      }))
    })
  }, [transport, scope, roomId, agentPrincipal, run])

  if (probe?.scope !== scope || !transport) {return { available: false, running: false }}

  return { available: probe?.available === true, running: Boolean(run && probe?.run === run && probe.running) }
}

/** The controller verifies the event in the bound room. Use a visible agent message or waiting
 * line from the current exchange. A missing ask still permits handing back control. */
export function agentScreenAskEvent(messages: MatrixMessage[], agentId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.redacted || message.decryptionFailed || message.pending || message.failed) {continue}
    if (message.own) {return undefined}
    if (message.sender === agentId && /^\$[^\s]{1,511}$/u.test(message.id) &&
        (message.progress ? message.progress.phase === 'waiting' : !message.notice)) {
      return message.id
    }
  }
}
