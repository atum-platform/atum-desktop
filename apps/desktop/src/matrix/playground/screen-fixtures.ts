import { type AgentScreenTransport, mockAgentScreenTransport } from '../agent-screen/transport'

/**
 * The agent's Screen on fixture data (plan 2026-11-28 S4): `?screen=1` gives the window the mock
 * transport, so Watch on the working line opens the Screen tab and Take over / Hand back and
 * continue run against an in-memory lease. `?screen=slow` holds each release for a few seconds, so
 * "Handing back…" can be seen. Nothing reaches a network and no frames are streamed: the stage
 * stays blank (the screenshot script draws a stand-in page into it).
 */
export function playgroundAgentScreen(params: URLSearchParams): { agentScreen: AgentScreenTransport } | Record<string, never> {
  const mode = params.get('screen')

  if (mode !== '1' && mode !== 'slow') {
    return {}
  }

  const transport = mockAgentScreenTransport()

  if (mode === 'slow') {
    const release = transport.release.bind(transport)

    transport.release = (...args) =>
      new Promise((resolve, reject) => {
        setTimeout(() => void release(...args).then(resolve, reject), 4_000)
      })
  }

  return { agentScreen: transport }
}
