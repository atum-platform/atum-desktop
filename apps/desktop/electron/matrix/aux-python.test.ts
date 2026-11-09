import { describe, expect, it } from 'vitest'

import { restoredAuxPython } from './aux-python'

describe('restored optional atum-aux interpreter', () => {
  it('re-derives a removed versioned Python from the current runtime', () => {
    expect(restoredAuxPython('mcp_servers:\n  atum-aux:\n    command: /old/runtime/bin/python3.11\n', '/new/bin/python3.13', () => false)).toBe('/new/bin/python3.13')
  })
  it.each(['ssh', 'python3', '/custom/bin/wrapper'])('preserves the command %s', command => {
    expect(restoredAuxPython(`mcp_servers:\n  atum-aux:\n    command: ${command}\n`, '/new/python', () => false)).toBeNull()
  })
  it('preserves an existing custom interpreter and unrelated MCP configuration', () => {
    expect(restoredAuxPython('mcp_servers:\n  atum-aux:\n    command: /custom/python3\n', '/new/python', () => true)).toBeNull()
    expect(restoredAuxPython('mcp_servers:\n  another:\n    command: /old/python3.11\n', '/new/python', () => false)).toBeNull()
  })
})
