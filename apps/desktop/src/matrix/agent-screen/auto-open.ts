import type { MatrixHermesActivitySnapshot } from '../../../shared/matrix-hermes-activity'

/** A tool that drives the agent's screen: its browser, or its whole desktop. */
export function agentScreenTool(name: string): boolean {
  return /^browser_[a-z0-9_]+$/u.test(name) || /^computer_use(?:_[a-z0-9_]+)?$/u.test(name)
}

export function agentScreenNativeRunning(
  activity: Pick<MatrixHermesActivitySnapshot, 'state' | 'tools'> | undefined
): boolean {
  return activity?.state === 'running' && activity.tools.some(tool => agentScreenTool(tool.name))
}

/** A local tool start or cloud display.status can open the panel once per observed run. */
export function agentScreenAutoOpen(input: {
  run: string | undefined
  lastOpened: string | undefined
  available: boolean
  compact: boolean
  running: boolean
}): boolean {
  return Boolean(input.run && input.run !== input.lastOpened && input.available && !input.compact && input.running)
}
