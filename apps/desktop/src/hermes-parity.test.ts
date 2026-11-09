import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getActionStatus,
  getCuratorStatus,
  getMcpCatalog,
  getMemoryStatus,
  getSkillHubSources,
  getToolsetModels,
  installSkillFromHub,
  resetMemory,
  runDebugShare,
  searchSkillsHub,
  selectToolsetModel,
  setApiRequestProfile,
  setCuratorPaused,
  setMcpServerEnabled,
  testMcpServer,
  uninstallSkillFromHub
} from './hermes'

describe('Hermes REST parity helpers (hub / mcp / maintenance)', () => {
  let api: ReturnType<typeof vi.fn>

  beforeEach(() => {
    api = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { api }
    })
  })

  afterEach(() => {
    setApiRequestProfile(null)
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('loads hub sources with a network-tolerant timeout', async () => {
    await getSkillHubSources()

    expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/skills/hub/sources', timeoutMs: 45_000 }))
  })

  it('encodes hub search params', async () => {
    await searchSkillsHub('gif search', 'official', 5)

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/skills/hub/search?q=gif+search&source=official&limit=5' })
    )
  })

  it('installs a hub skill by identifier', async () => {
    await installSkillFromHub('official/gifs/gif-search')

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/skills/hub/install',
        method: 'POST',
        body: { identifier: 'official/gifs/gif-search' }
      })
    )
  })

  it('routes explicit named hub targets through primary with the profile in the hub request', async () => {
    setApiRequestProfile('mkt-taylor')

    await getSkillHubSources({ profile: 'atum-alfred' })
    await installSkillFromHub('official/finance/stocks', { profile: 'atum-alfred' })
    await uninstallSkillFromHub('stocks', { profile: 'atum-alfred' })
    await getActionStatus('skill-install-stocks', 200, { profile: 'atum-alfred' })

    expect(api).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ path: '/api/skills/hub/sources?profile=atum-alfred' })
    )
    expect(api.mock.calls[0]![0]).not.toHaveProperty('profile')
    expect(api).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ body: { identifier: 'official/finance/stocks', profile: 'atum-alfred' } })
    )
    expect(api.mock.calls[1]![0]).not.toHaveProperty('profile')
    expect(api).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ body: { name: 'stocks', profile: 'atum-alfred' } })
    )
    expect(api.mock.calls[2]![0]).not.toHaveProperty('profile')
    expect(api.mock.calls[3]![0]).not.toHaveProperty('profile')
  })

  it('omits a null target everywhere while preserving legacy active-profile routing', async () => {
    setApiRequestProfile('mkt-taylor')

    await getSkillHubSources({ profile: null })
    await installSkillFromHub('official/finance/stocks', { profile: null })
    await installSkillFromHub('official/finance/stocks')

    expect(api.mock.calls[0]![0]).not.toHaveProperty('profile')
    expect(api.mock.calls[0]![0].path).toBe('/api/skills/hub/sources')
    expect(api.mock.calls[1]![0]).not.toHaveProperty('profile')
    expect(api.mock.calls[1]![0].body).toEqual({ identifier: 'official/finance/stocks' })
    expect(api.mock.calls[2]![0]).toEqual(
      expect.objectContaining({
        body: { identifier: 'official/finance/stocks' },
        profile: 'mkt-taylor'
      })
    )
  })

  it('tests an MCP server with a boot-tolerant timeout and encoded name', async () => {
    await testMcpServer('file system')

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/mcp/servers/file%20system/test',
        method: 'POST',
        timeoutMs: 60_000
      })
    )
  })

  it('toggles MCP server enablement', async () => {
    await setMcpServerEnabled('filesystem', false)

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/mcp/servers/filesystem/enabled',
        method: 'PUT',
        body: { enabled: false }
      })
    )
  })

  it('reads the MCP catalog', async () => {
    await getMcpCatalog()

    expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/mcp/catalog' }))
  })

  it('reads memory status and resets a specific target', async () => {
    await getMemoryStatus()
    await resetMemory('user')

    expect(api).toHaveBeenNthCalledWith(1, expect.objectContaining({ path: '/api/memory' }))
    expect(api).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ path: '/api/memory/reset', method: 'POST', body: { target: 'user' } })
    )
  })

  it('manages the curator', async () => {
    await getCuratorStatus()
    await setCuratorPaused(true)

    expect(api).toHaveBeenNthCalledWith(1, expect.objectContaining({ path: '/api/curator' }))
    expect(api).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ path: '/api/curator/paused', method: 'PUT', body: { paused: true } })
    )
  })

  it('runs debug share synchronously with an upload-tolerant timeout', async () => {
    await runDebugShare()

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/ops/debug-share', method: 'POST', timeoutMs: 120_000 })
    )
  })

  it('reads a backend model catalog scoped to a provider row', async () => {
    await getToolsetModels('image_gen', 'FAL.ai')

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/tools/toolsets/image_gen/models?provider=FAL.ai' })
    )
  })

  it('persists a backend model selection', async () => {
    await selectToolsetModel('image_gen', 'z-image-turbo', 'FAL.ai')

    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/tools/toolsets/image_gen/model',
        method: 'PUT',
        body: { model: 'z-image-turbo', provider: 'FAL.ai' }
      })
    )
  })
})
