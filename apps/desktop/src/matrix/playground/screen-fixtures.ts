import { mockAgentScreenTransport } from '../agent-screen/mock-transport'
import { installPlaygroundAgentScreen } from '../agent-screen/transport'

/**
 * The agent's Screen on fixture data (plan 2026-11-28 S4): `?screen=1` gives the window the mock
 * transport, so Watch on the working line opens the Screen tab and Take over / Hand back and
 * continue run against an in-memory lease. `?screen=slow` holds each release for a few seconds, so
 * "Handing back…" can be seen. Nothing reaches a network and no frames are streamed: the stage
 * stays blank (the screenshot script draws a stand-in page into it).
 */
export function playgroundAgentScreen(params: URLSearchParams): void {
  const mode = params.get('screen')

  if (mode !== '1' && mode !== 'slow') {
    return
  }

  const transport = mockAgentScreenTransport()

  if (mode === 'slow') {
    const handback = transport.handback
    const release = transport.release
    const delay = () => new Promise<void>(resolve => setTimeout(resolve, 4_000))
    transport.handback = async (...args) => {
      await delay()
      return handback(...args)
    }
    transport.release = async (...args) => {
      await delay()
      return release(...args)
    }
  }

  installPlaygroundAgentScreen(transport)
}
