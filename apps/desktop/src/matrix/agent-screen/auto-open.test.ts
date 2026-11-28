import { describe, expect, it } from 'vitest'

import { matrixHermesProgressEvent } from '../../../shared/matrix-progress-line'

import { agentScreenAutoOpen, agentScreenNativeRunning, agentScreenTool } from './auto-open'

describe('agent screen auto-open', () => {
  it('recognizes the tool names in native Hermes progress', () => {
    for (const name of ['browser_navigate', 'browser_click', 'browser_type', 'computer_use']) {
      expect(agentScreenTool(name)).toBe(true)
    }

    for (const name of ['web_search', 'web_extract', 'terminal', 'read_file', 'vision_analyze', 'browserish']) {
      expect(agentScreenTool(name)).toBe(false)
    }

    const progress = matrixHermesProgressEvent('tool.start', { name: 'browser_navigate' })
    expect(progress).toEqual({ kind: 'tool', name: 'browser_navigate' })
    expect(agentScreenNativeRunning({ state: 'running', tools: [{ name: 'browser_navigate', state: 'running' }] })).toBe(true)
    expect(agentScreenNativeRunning({ state: 'complete', tools: [{ name: 'browser_navigate', state: 'running' }] })).toBe(false)
  })

  it('opens from a positive cloud status once per busy run, with compact and availability gates', () => {
    const input = { available: true, compact: false, lastOpened: undefined, run: '$cloud-turn', running: true }
    expect(agentScreenAutoOpen(input)).toBe(true)
    expect(agentScreenAutoOpen({ ...input, lastOpened: input.run })).toBe(false)
    expect(agentScreenAutoOpen({ ...input, run: '$next-turn', lastOpened: input.run })).toBe(true)
    expect(agentScreenAutoOpen({ ...input, available: false })).toBe(false)
    expect(agentScreenAutoOpen({ ...input, compact: true })).toBe(false)
    expect(agentScreenAutoOpen({ ...input, run: undefined })).toBe(false)
    expect(agentScreenAutoOpen({ ...input, running: false })).toBe(false)
  })
})
