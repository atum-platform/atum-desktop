import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  isWorkspaceTextRendererApiDenied,
  WorkspaceTextFileRemoteAdapter
} from './workspace-text-file-remote'

test('configured custody denies raw and opaque remote filesystem routes through generic renderer API', () => {
  assert.equal(isWorkspaceTextRendererApiDenied('/api/fs/read-text?path=%2Fsecret'), true)
  assert.equal(isWorkspaceTextRendererApiDenied('/api/fs/read-data-url?path=%2Fsecret'), true)
  assert.equal(isWorkspaceTextRendererApiDenied('/api/fs/write-text'), true)
  assert.equal(isWorkspaceTextRendererApiDenied('/api/fs/workspace-text-leases/open'), true)
  assert.equal(isWorkspaceTextRendererApiDenied('/api/fs/list?path=%2Fworkspace'), true)
  assert.equal(isWorkspaceTextRendererApiDenied('/api/profiles/sessions'), false)
})

test('remote adapter routes raw paths only during privileged open and validates opaque ids', async () => {
  const calls: unknown[][] = []

  const adapter = new WorkspaceTextFileRemoteAdapter(async (...input) => {
    calls.push(input)

    if (input[0] === '/api/fs/workspace-text-leases/open') {
      return { leaseId: 'a'.repeat(32), displayName: 'note.txt' }
    }

    return { revision: 'sha256:r', text: 'x', truncated: false }
  })

  const opened = await adapter.open('/remote/private/note.txt')
  await adapter.read(opened.leaseId)

  assert.deepEqual(calls, [
    ['/api/fs/workspace-text-leases/open', 'POST', { path: '/remote/private/note.txt' }],
    [`/api/fs/workspace-text-leases/${'a'.repeat(32)}`, 'GET']
  ])
  await assert.rejects(adapter.read('../escape'), /CAPABILITY_DENIED/u)
})
