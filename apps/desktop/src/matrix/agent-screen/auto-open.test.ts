import { describe, expect, it } from 'vitest'

import type { MatrixHermesActivitySnapshot } from '../../../shared/matrix-hermes-activity'
import { matrixHermesProgressEvent } from '../../../shared/matrix-progress-line'

import { agentScreenAutoOpen, agentScreenTool } from './auto-open'

function activity(invocationId: string, names: string[], state: MatrixHermesActivitySnapshot['state'] = 'running') {
  return {
    invocationId,
    state,
    tools: names.map(name => ({ name, state: 'running' as const }))
  }
}

describe('agent screen auto-open', () => {
  it('knows the tools that drive the screen', () => {
    for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'computer_use']) {
      expect(agentScreenTool(name)).toBe(true)
    }

    for (const name of ['web_search', 'web_extract', 'terminal', 'read_file', 'vision_analyze', 'browserish']) {
      expect(agentScreenTool(name)).toBe(false)
    }
  })

  it('reads the same tool names the progress stream carries', () => {
    const progress = matrixHermesProgressEvent('tool.start', { name: 'browser_navigate' })

    expect(progress).toEqual({ kind: 'tool', name: 'browser_navigate' })
    expect(progress?.kind === 'tool' && agentScreenTool(progress.name)).toBe(true)
  })

  it('opens once, on the run’s first screen step', () => {
    const opened = new Set<string>()

    expect(agentScreenAutoOpen(activity('run-1', ['web_search']), opened)).toBe(false)
    expect(agentScreenAutoOpen(activity('run-1', ['web_search', 'browser_navigate']), opened)).toBe(true)
    // Closing the tab mid-run: the next click does not pull it back.
    expect(agentScreenAutoOpen(activity('run-1', ['web_search', 'browser_navigate', 'browser_click']), opened)).toBe(false)
    // The next run may open it again.
    expect(agentScreenAutoOpen(activity('run-2', ['computer_use']), opened)).toBe(true)
  })

  it('never opens for a finished run or no run', () => {
    const opened = new Set<string>()

    expect(agentScreenAutoOpen(undefined, opened)).toBe(false)
    expect(agentScreenAutoOpen(activity('run-3', ['browser_navigate'], 'complete'), opened)).toBe(false)
    expect(agentScreenAutoOpen(activity('run-3', ['browser_navigate'], 'stopped'), opened)).toBe(false)
  })
})
