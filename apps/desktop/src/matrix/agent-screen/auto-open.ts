/**
 * When the Screen opens by itself: on the run's first browser or computer-use step (plan S4).
 *
 * The tool names are Hermes's own (`browser_navigate`, `browser_click`, ..., `computer_use`), the
 * same names `matrixHermesProgressEvent` passes on as `{ kind: 'tool', name }` and the activity
 * projection carries per invocation. One open per run: a person who closes the tab mid-run is not
 * pulled back by the next click; the next run may open it again.
 */
import type { MatrixHermesActivitySnapshot } from '../../../shared/matrix-hermes-activity'

/** A tool that drives the agent's screen: its browser, or its whole desktop. */
export function agentScreenTool(name: string): boolean {
  return /^browser_[a-z0-9_]+$/u.test(name) || /^computer_use(?:_[a-z0-9_]+)?$/u.test(name)
}

/**
 * Should this activity open the Screen now? `opened` remembers the runs (invocation ids) that
 * already opened it; the caller keeps it for the life of the window.
 */
export function agentScreenAutoOpen(
  activity: Pick<MatrixHermesActivitySnapshot, 'invocationId' | 'state' | 'tools'> | undefined,
  opened: Set<string>
): boolean {
  if (!activity || activity.state !== 'running' || opened.has(activity.invocationId)) {
    return false
  }

  if (!activity.tools.some(tool => agentScreenTool(tool.name))) {
    return false
  }

  opened.add(activity.invocationId)

  return true
}
