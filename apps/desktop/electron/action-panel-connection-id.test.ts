import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { actionPanelConnectionId } from './action-panel-connection-id'

test('connection namespace survives tickets, credentials, restart and local ports; different endpoints remain separate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atum-connection-id-'))

  try {
    const local = actionPanelConnectionId(directory, { mode: 'local', baseUrl: 'http://127.0.0.1:1234' })
    expect(actionPanelConnectionId(directory, { mode: 'local', baseUrl: 'http://127.0.0.1:5678' })).toBe(local)
    const remote = actionPanelConnectionId(directory, { mode: 'remote', baseUrl: 'https://user:password@remote.example/prefix?ticket=old' })
    expect(actionPanelConnectionId(directory, { mode: 'remote', baseUrl: 'https://remote.example/prefix?ticket=new' })).toBe(remote)
    expect(remote).not.toBe(local)
    expect(actionPanelConnectionId(directory, { mode: 'remote', baseUrl: 'https://other.example/prefix' })).not.toBe(remote)
  } finally {rmSync(directory, { recursive: true, force: true })}
})
