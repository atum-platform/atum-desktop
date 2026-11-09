// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HubPresentationProps } from '@/app/skills/hub-presentation'
import type { ActionResponse, SkillHubScanResult } from '@/types/hermes'

import { MatrixSkillsHub, type MatrixSkillsHubClient } from './skills-hub'

const state = vi.hoisted(() => ({ props: undefined as HubPresentationProps | undefined, errors: [] as unknown[] }))
vi.mock('@/app/skills/hub-presentation', () => ({
  HubPresentation: (props: HubPresentationProps) => {
    state.props = props

    return (
      <button
        onClick={() => void props.onInstall('official/fixture', 'Fixture').catch(error => state.errors.push(error))}
      >
        {props.actions['official/fixture']?.running ? 'Pending' : 'Install'}
      </button>
    )
  }
}))

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { promise, resolve }
}

function setup(overrides: Partial<MatrixSkillsHubClient> = {}) {
  const client: MatrixSkillsHubClient = {
    getSources: vi.fn().mockResolvedValue({ sources: [], installed: {}, featured: [], index_available: false }),
    search: vi.fn(),
    preview: vi.fn(),
    scan: vi.fn(),
    uninstall: vi.fn().mockResolvedValue({ ok: true, name: 'skills-archive-fixture-12345678', pid: 12 }),
    update: vi.fn().mockResolvedValue({ ok: true, name: 'skills-update-fixture-12345678', pid: 13 }),
    install: vi.fn().mockResolvedValue({ ok: true, name: 'skills-install-fixture-12345678', pid: 11 }),
    status: vi.fn().mockResolvedValue({
      name: 'skills-install-fixture-12345678',
      running: false,
      exit_code: 0,
      pid: 11,
      lines: ['Installed']
    }),
    ...overrides
  }

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidated = vi.spyOn(cache, 'invalidateQueries')
  const onInstalled = vi.fn()

  const view = render(
    <QueryClientProvider client={cache}>
      <MatrixSkillsHub client={client} onInstalled={onInstalled} query="" />
    </QueryClientProvider>
  )

  return { client, cache, invalidated, onInstalled, ...view }
}

afterEach(() => {
  cleanup()
  state.errors = []
  state.props = undefined
  vi.restoreAllMocks()
})

describe('native Skills Hub observation', () => {
  it('returns the actual scan result without an installation or cache update', async () => {
    const result = { identifier: 'official/fixture', policy: 'block' } as SkillHubScanResult
    const { client, invalidated, onInstalled } = setup({ scan: vi.fn().mockResolvedValue(result) })
    await expect(state.props!.onScan!('official/fixture')).resolves.toBe(result)
    expect(client.scan).toHaveBeenCalledWith('official/fixture')
    expect(client.install).not.toHaveBeenCalled()
    expect(client.status).not.toHaveBeenCalled()
    expect(invalidated).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('cancelled scan rejects quietly as an abort, never a synthetic safe verdict', async () => {
    setup({ scan: vi.fn().mockRejectedValue(new Error('matrix_pages_hub_scan_cancelled')) })
    await expect(state.props!.onScan!('official/fixture')).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not hide a real scan failure', async () => {
    setup({ scan: vi.fn().mockRejectedValue(new Error('upstream scan unavailable')) })
    await expect(state.props!.onScan!('official/fixture')).rejects.toThrow('upstream scan unavailable')
  })

  it('does not mistake an echoed cancellation substring for the exact native cancel code', async () => {
    const message = 'upstream failed while scanning a skill containing matrix_pages_hub_scan_cancelled'
    setup({ scan: vi.fn().mockRejectedValue(new Error(message)) })
    await expect(state.props!.onScan!('official/fixture')).rejects.toThrow(message)
  })

  it('closing a page fences a late scan and prevents a stale callback dispatch', async () => {
    const result = deferred<SkillHubScanResult>()
    const { client, onInstalled, unmount } = setup({ scan: vi.fn(() => result.promise) })
    const scan = state.props!.onScan!
    const pendingScan = expect(scan('official/fixture')).rejects.toMatchObject({ name: 'AbortError' })
    unmount()
    await act(async () => result.resolve({ identifier: 'official/fixture' } as SkillHubScanResult))
    await pendingScan
    await expect(scan('official/other')).rejects.toMatchObject({ name: 'AbortError' })
    expect(client.scan).toHaveBeenCalledOnce()
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('waits for native confirmation, polls only its returned action, then refreshes truth', async () => {
    const started = deferred<ActionResponse>()
    const { client, invalidated, onInstalled } = setup({ install: vi.fn(() => started.promise) })
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Pending')).toBeTruthy()
    expect(client.status).not.toHaveBeenCalled()
    await act(async () => started.resolve({ ok: true, name: 'issued-name', pid: 11 }))
    await waitFor(() => expect(onInstalled).toHaveBeenCalledOnce())
    expect(client.status).toHaveBeenCalledWith('issued-name')
    expect(invalidated).toHaveBeenCalledWith({ queryKey: state.props!.queryKeyPrefix })
    expect(state.props!.installedOverrides).toEqual({})
    expect(state.props!.actions['official/fixture']).toMatchObject({
      running: false,
      exitCode: 0,
      lines: ['Installed']
    })
    expect(state.errors).toEqual([])
  })

  it('does not dispatch a duplicate install before the pending render', async () => {
    const started = deferred<ActionResponse>()
    const { client } = setup({ install: vi.fn(() => started.promise) })
    await act(async () => {
      void state.props!.onInstall('official/fixture', 'Fixture')
      void state.props!.onInstall('official/fixture', 'Fixture')
    })
    expect(client.install).toHaveBeenCalledOnce()
    await act(async () => started.resolve({ ok: true, name: 'issued-name', pid: 11 }))
  })

  it('treats cancelled confirmation as no installation, not an alarming failure', async () => {
    const { client } = setup({ install: vi.fn().mockRejectedValue(new Error('matrix_pages_hub_install_cancelled')) })
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByText('Install')).toBeTruthy())
    expect(client.status).not.toHaveBeenCalled()
    expect(state.errors).toEqual([])
    expect(state.props!.installedOverrides).toEqual({})
  })

  it('closing during confirmation stops observation, not the upstream operation', async () => {
    const started = deferred<ActionResponse>()
    const { client, onInstalled, unmount } = setup({ install: vi.fn(() => started.promise) })
    fireEvent.click(screen.getByRole('button'))
    unmount()
    await act(async () => started.resolve({ ok: true, name: 'issued-name', pid: 11 }))
    expect(client.status).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
    expect(state.errors).toEqual([])
  })

  it('a lost status read refreshes installed truth without claiming a successful install', async () => {
    const { onInstalled } = setup({ status: vi.fn().mockRejectedValue(new Error('pages_request_failed')) })
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(state.errors).toHaveLength(1))
    expect(onInstalled).toHaveBeenCalledOnce()
    expect(state.props!.actions['official/fixture']).toMatchObject({ running: false, lines: ['pages_request_failed'] })
    expect(state.props!.installedOverrides).toEqual({})
  })

  it('a nonzero installer result is surfaced with its log, never an installed override', async () => {
    setup({
      status: vi
        .fn()
        .mockResolvedValue({ name: 'issued-name', running: false, exit_code: 1, pid: 11, lines: ['Blocked by scan'] })
    })
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(state.errors).toHaveLength(1))
    expect(state.props!.actions['official/fixture']?.lines[0]).toBe('Blocked by scan')
    expect(state.props!.installedOverrides).toEqual({})
  })
})

describe('selected-agent archive observation', () => {
  it('waits for its native action and refreshes actual installed truth without an optimistic removal', async () => {
    const started = deferred<ActionResponse>()
    const { client, invalidated, onInstalled } = setup({ uninstall: vi.fn(() => started.promise) })
    let operation!: Promise<void>
    await act(async () => {
      operation = state.props!.onUninstall!('official/fixture', 'installed-fixture')
    })
    expect(client.uninstall).toHaveBeenCalledWith('installed-fixture')
    expect(client.install).not.toHaveBeenCalled()
    expect(client.status).not.toHaveBeenCalled()
    expect(state.props!.actions['official/fixture']).toMatchObject({ kind: 'archive', running: true })
    await act(async () => {
      started.resolve({ ok: true, name: 'owned-archive', pid: 12 })
      await operation
    })
    expect(client.status).toHaveBeenCalledWith('owned-archive')
    expect(onInstalled).toHaveBeenCalledOnce()
    expect(invalidated).toHaveBeenCalledWith({ queryKey: state.props!.queryKeyPrefix })
    expect(state.props!.installedOverrides).toEqual({})
    expect(state.props!.uninstallLabel).toBe('Archive')
    expect(state.props!.onUpdateAll).toBeTypeOf('function')
  })

  it('serializes install and archive of the same row before React can render', async () => {
    const started = deferred<ActionResponse>()
    const { client } = setup({ uninstall: vi.fn(() => started.promise) })
    let operation!: Promise<void>
    await act(async () => {
      operation = state.props!.onUninstall!('official/fixture', 'installed-fixture')
      void state.props!.onInstall('official/fixture', 'Fixture')
      void state.props!.onUninstall!('official/fixture', 'installed-fixture')
    })
    expect(client.uninstall).toHaveBeenCalledOnce()
    expect(client.install).not.toHaveBeenCalled()
    await act(async () => {
      started.resolve({ ok: true, name: 'owned-archive', pid: 12 })
      await operation
    })
  })

  it('cancelled archive is quiet and does not poll an action', async () => {
    const { client } = setup({ uninstall: vi.fn().mockRejectedValue(new Error('matrix_pages_hub_archive_cancelled')) })
    await act(async () => {
      await state.props!.onUninstall!('official/fixture', 'installed-fixture')
    })
    expect(client.status).not.toHaveBeenCalled()
    expect(state.props!.actions['official/fixture']).toBeUndefined()
    expect(state.props!.installedOverrides).toEqual({})
  })

  it('closing during confirmation stops late observation without cancelling the upstream archive', async () => {
    const started = deferred<ActionResponse>()
    const { client, onInstalled, unmount } = setup({ uninstall: vi.fn(() => started.promise) })
    let operation!: Promise<void>
    await act(async () => {
      operation = state.props!.onUninstall!('official/fixture', 'installed-fixture')
    })
    unmount()
    await act(async () => {
      started.resolve({ ok: true, name: 'owned-archive', pid: 12 })
      await operation
    })
    expect(client.status).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('a refused archive and a lost status read preserve actual authority and report their logs', async () => {
    const { client, onInstalled } = setup({
      status: vi.fn().mockResolvedValue({
        name: 'owned-archive',
        running: false,
        exit_code: 1,
        pid: 12,
        lines: ['Archive refused; bytes preserved']
      })
    })

    await act(async () => {
      await expect(state.props!.onUninstall!('official/fixture', 'installed-fixture')).rejects.toThrow(
        'could not be archived'
      )
    })
    expect(state.props!.actions['official/fixture']?.lines[0]).toBe('Archive refused; bytes preserved')
    expect(state.props!.installedOverrides).toEqual({})
    vi.mocked(client.status).mockRejectedValue(new Error('connection lost'))
    await act(async () => {
      await expect(state.props!.onUninstall!('official/fixture', 'installed-fixture')).rejects.toThrow(
        'connection lost'
      )
    })
    expect(onInstalled).toHaveBeenCalledTimes(2)
    expect(state.props!.installedOverrides).toEqual({})
  })
})

describe('selected-agent update observation', () => {
  it('updates one installed skill by its exact installed name and refreshes only observed truth', async () => {
    const started = deferred<ActionResponse>()
    const { client, invalidated, onInstalled } = setup({ update: vi.fn(() => started.promise) })
    let operation!: Promise<void>
    await act(async () => {
      operation = state.props!.onUpdate!('official/fixture', 'installed-fixture')
    })
    expect(client.update).toHaveBeenCalledWith('installed-fixture')
    expect(client.install).not.toHaveBeenCalled()
    expect(client.uninstall).not.toHaveBeenCalled()
    expect(state.props!.actions['official/fixture']).toMatchObject({ kind: 'update', running: true })
    await act(async () => {
      started.resolve({ ok: true, name: 'owned-update', pid: 13 })
      await operation
    })
    expect(client.status).toHaveBeenCalledWith('owned-update')
    expect(onInstalled).toHaveBeenCalledOnce()
    expect(invalidated).toHaveBeenCalledWith({ queryKey: state.props!.queryKeyPrefix })
    expect(state.props!.installedOverrides).toEqual({})
  })

  it('updates all installed skills with an undefined selector and serializes concurrent per-skill mutations', async () => {
    const started = deferred<ActionResponse>()
    const { client, invalidated, onInstalled } = setup({ update: vi.fn(() => started.promise) })
    let operation!: Promise<void>
    await act(async () => {
      operation = state.props!.onUpdateAll!()
      void state.props!.onUpdate!('official/fixture', 'installed-fixture')
    })
    expect(client.update).toHaveBeenCalledOnce()
    expect(client.update).toHaveBeenCalledWith(undefined)
    expect(state.props!.actions.__update_all__).toMatchObject({ kind: 'update-all', running: true })
    await act(async () => {
      started.resolve({ ok: true, name: 'owned-update-all', pid: 13 })
      await operation
    })
    expect(onInstalled).toHaveBeenCalledOnce()
    expect(invalidated).toHaveBeenCalledWith({ queryKey: state.props!.queryKeyPrefix })
  })

  it('treats cancelled update confirmation quietly and does not poll', async () => {
    const { client } = setup({ update: vi.fn().mockRejectedValue(new Error('matrix_pages_hub_update_cancelled')) })
    await act(async () => {
      await state.props!.onUpdate!('official/fixture', 'installed-fixture')
    })
    expect(client.status).not.toHaveBeenCalled()
    expect(state.props!.actions['official/fixture']).toBeUndefined()
    expect(state.props!.installedOverrides).toEqual({})
  })

  it('treats cancelled update-all confirmation quietly and does not poll', async () => {
    const { client } = setup({ update: vi.fn().mockRejectedValue(new Error('matrix_pages_hub_update-all_cancelled')) })
    await act(async () => {
      await state.props!.onUpdateAll!()
    })
    expect(client.status).not.toHaveBeenCalled()
    expect(state.props!.actions.__update_all__).toBeUndefined()
    expect(state.props!.installedOverrides).toEqual({})
  })

  it('surfaces an unavailable safe-update runtime without a legacy fallback', async () => {
    const { client, onInstalled } = setup({
      update: vi.fn().mockRejectedValue(new Error('update-safe is unavailable'))
    })

    await act(async () => {
      await expect(state.props!.onUpdate!('official/fixture', 'installed-fixture')).rejects.toThrow(
        'update-safe is unavailable'
      )
    })
    expect(client.update).toHaveBeenCalledWith('installed-fixture')
    expect(client.status).not.toHaveBeenCalled()
    expect(onInstalled).toHaveBeenCalledOnce()
    expect(state.props!.actions['official/fixture']).toMatchObject({
      running: false,
      lines: ['update-safe is unavailable']
    })
    expect(state.props!.installedOverrides).toEqual({})
  })

  it('shows a partial nonzero update result without inventing installed state', async () => {
    const { client } = setup({
      status: vi.fn().mockResolvedValue({
        name: 'owned-update-all',
        running: false,
        exit_code: 1,
        pid: 13,
        lines: ['fixture: updated', 'other: conflict']
      })
    })

    await act(async () => {
      await expect(state.props!.onUpdateAll!()).rejects.toThrow('did not complete')
    })
    expect(client.status).toHaveBeenCalledWith('skills-update-fixture-12345678')
    expect(state.props!.actions.__update_all__?.lines).toEqual([
      'fixture: updated',
      'other: conflict',
      'The skill update did not complete. Review its log before retrying.'
    ])
    expect(state.props!.installedOverrides).toEqual({})
  })

  it('refreshes installed truth after a lost update status read without a success claim', async () => {
    const { client, onInstalled } = setup({ status: vi.fn().mockRejectedValue(new Error('connection lost')) })
    await act(async () => {
      await expect(state.props!.onUpdate!('official/fixture', 'installed-fixture')).rejects.toThrow('connection lost')
    })
    expect(onInstalled).toHaveBeenCalledOnce()
    expect(state.props!.actions['official/fixture']).toMatchObject({ running: false, lines: ['connection lost'] })
    expect(state.props!.installedOverrides).toEqual({})
  })

  it('ignores a late update start after unmounting without cancelling its native request', async () => {
    const started = deferred<ActionResponse>()
    const { client, onInstalled, unmount } = setup({ update: vi.fn(() => started.promise) })
    let operation!: Promise<void>
    await act(async () => {
      operation = state.props!.onUpdate!('official/fixture', 'installed-fixture')
    })
    unmount()
    await act(async () => {
      started.resolve({ ok: true, name: 'owned-update', pid: 13 })
      await operation
    })
    expect(client.status).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
  })
})
