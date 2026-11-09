import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getGlobalModelInfo } from '@/hermes'
import { modelOptionsQueryKey } from '@/lib/model-options'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $busy,
  $currentModel,
  $currentProvider,
  $currentReasoningEffort,
  getCurrentModelSource,
  setCurrentModel,
  setCurrentModelSource,
  setCurrentProvider,
  setCurrentReasoningEffort
} from '@/store/session'
import type * as SessionStates from '@/store/session-states'

import { resetModelPickCoordination, useModelControls } from './use-model-controls'

const setGlobalModel = vi.fn()
const notifyError = vi.fn()

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void

  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, reject, resolve }
}

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: vi.fn(),
  setApiRequestProfile: vi.fn(),
  setGlobalModel: (...args: Parameters<typeof setGlobalModel>) => setGlobalModel(...args)
}))

vi.mock('@/store/session-states', async importOriginal => {
  const actual = await importOriginal<typeof SessionStates>()

  return {
    ...actual,
    sessionTileDelegate: () => null
  }
})

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      desktop: {
        modelSwitchFailed: 'Model switch failed'
      }
    }
  })
}))

vi.mock('@/store/notifications', () => ({
  notifyError: (...args: Parameters<typeof notifyError>) => notifyError(...args)
}))

type Controls = ReturnType<typeof useModelControls>

function Harness({
  onReady,
  requestGateway
}: {
  onReady: (controls: Controls) => void
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}) {
  const controls = useModelControls({
    queryClient: new QueryClient(),
    requestGateway
  })

  onReady(controls)

  return null
}

describe('useModelControls', () => {
  beforeEach(() => {
    resetModelPickCoordination()
    $busy.set(false)
    $activeGatewayProfile.set('default')
    $activeSessionId.set(null)
    setCurrentModel('')
    setCurrentModelSource('')
    setCurrentProvider('')
    setCurrentReasoningEffort('')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    resetModelPickCoordination()
    $busy.set(false)
    $activeGatewayProfile.set('default')
    $activeSessionId.set(null)
    setCurrentModel('')
    setCurrentModelSource('')
    setCurrentProvider('')
    setCurrentReasoningEffort('')
  })

  it('applies the global model when there is no active runtime session', async () => {
    vi.mocked(getGlobalModelInfo).mockResolvedValue({
      model: 'openai/gpt-5.5',
      provider: 'openai-codex'
    })

    const { result } = renderHook(() =>
      useModelControls({
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    await result.current.refreshCurrentModel()

    expect($currentModel.get()).toBe('openai/gpt-5.5')
    expect($currentProvider.get()).toBe('openai-codex')
    expect(getCurrentModelSource()).toBe('default')
  })

  it('does not clobber the active session footer state with global model info', async () => {
    setCurrentModel('deepseek/deepseek-v4-pro')
    setCurrentProvider('deepseek')
    $activeSessionId.set('runtime-1')
    vi.mocked(getGlobalModelInfo).mockResolvedValue({
      model: 'openai/gpt-5.5',
      provider: 'openai-codex'
    })

    const { result } = renderHook(() =>
      useModelControls({
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    await result.current.refreshCurrentModel()

    expect($currentModel.get()).toBe('deepseek/deepseek-v4-pro')
    expect($currentProvider.get()).toBe('deepseek')
  })

  it('routes active-session picker changes through config.set with an explicit session-scoped provider', async () => {
    $activeSessionId.set('session-1')
    const requestGateway = vi.fn(async () => ({ key: 'model', value: 'claude-sonnet-4.6' }) as never)
    let controls!: Controls

    render(<Harness onReady={value => (controls = value)} requestGateway={requestGateway} />)

    await expect(
      controls.selectModel({
        model: 'claude-sonnet-4.6',
        provider: 'anthropic'
      })
    ).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('config.set', {
      session_id: 'session-1',
      key: 'model',
      value: 'claude-sonnet-4.6 --provider anthropic --session'
    })
    expect(requestGateway).not.toHaveBeenCalledWith('slash.exec', expect.anything())
  })

  it('applies a slider model and its advertised effort to the same live session', async () => {
    $activeSessionId.set('session-1')
    const requestGateway = vi.fn(async () => ({ ok: true }) as never)
    let controls!: Controls

    render(<Harness onReady={value => (controls = value)} requestGateway={requestGateway} />)

    await expect(
      controls.selectModel({ effort: 'max', model: 'nguyet-thuc', provider: 'atum-managed' })
    ).resolves.toBe(true)

    expect(requestGateway).toHaveBeenNthCalledWith(1, 'config.set', {
      key: 'model',
      session_id: 'session-1',
      value: 'nguyet-thuc --provider atum-managed --session'
    })
    expect(requestGateway).toHaveBeenNthCalledWith(2, 'config.set', {
      key: 'reasoning',
      session_id: 'session-1',
      value: 'max'
    })
    expect($currentReasoningEffort.get()).toBe('max')
  })

  it('rolls back an optimistic slider pair when the effort write fails', async () => {
    $activeSessionId.set('session-1')
    setCurrentModel('binh-minh')
    setCurrentProvider('atum-managed')
    setCurrentReasoningEffort('low')

    const requestGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('reasoning rejected'))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })

    let controls!: Controls

    render(<Harness onReady={value => (controls = value)} requestGateway={requestGateway} />)

    await expect(
      controls.selectModel({ effort: 'max', model: 'nguyet-thuc', provider: 'atum-managed' })
    ).resolves.toBe(false)

    expect($currentModel.get()).toBe('binh-minh')
    expect($currentProvider.get()).toBe('atum-managed')
    expect($currentReasoningEffort.get()).toBe('low')
    expect(requestGateway).toHaveBeenNthCalledWith(3, 'config.set', {
      key: 'model',
      session_id: 'session-1',
      value: 'binh-minh --provider atum-managed --session'
    })
    expect(requestGateway).toHaveBeenNthCalledWith(4, 'config.set', {
      key: 'reasoning',
      session_id: 'session-1',
      value: 'low'
    })
    expect(notifyError).toHaveBeenCalled()
  })

  it('session-scopes MoA preset selections so they cannot persist as the global gateway default', async () => {
    $activeSessionId.set('session-1')
    const requestGateway = vi.fn(async () => ({ key: 'model', value: 'BeastMode' }) as never)
    let controls!: Controls

    render(<Harness onReady={value => (controls = value)} requestGateway={requestGateway} />)

    await expect(
      controls.selectModel({
        model: 'BeastMode',
        provider: 'moa'
      })
    ).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('config.set', {
      session_id: 'session-1',
      key: 'model',
      value: 'BeastMode --provider moa --session'
    })
  })

  it('stores a no-session pick as UI state with no gateway or global write', async () => {
    const requestGateway = vi.fn()
    let controls!: Controls

    render(<Harness onReady={value => (controls = value)} requestGateway={requestGateway} />)

    await expect(
      controls.selectModel({
        model: 'claude-sonnet-4.6',
        provider: 'anthropic'
      })
    ).resolves.toBe(true)

    // The pick is plain UI state; session.create ships it later. Nothing touches
    // the gateway or the profile default here.
    expect($currentModel.get()).toBe('claude-sonnet-4.6')
    expect($currentProvider.get()).toBe('anthropic')
    expect(getCurrentModelSource()).toBe('manual')
    expect(requestGateway).not.toHaveBeenCalled()
    expect(setGlobalModel).not.toHaveBeenCalled()
  })

  it('updates only the active profile new-chat cache', async () => {
    const queryClient = new QueryClient()
    $activeGatewayProfile.set('compass')

    const { result } = renderHook(() =>
      useModelControls({
        queryClient,
        requestGateway: vi.fn()
      })
    )

    await result.current.selectModel({ model: 'qwen3.6:35b-65k', provider: 'custom:local-ollama' })

    expect(queryClient.getQueryData(modelOptionsQueryKey('compass'))).toMatchObject({
      model: 'qwen3.6:35b-65k',
      provider: 'custom:local-ollama'
    })
    expect(queryClient.getQueryData(modelOptionsQueryKey('default'))).toBeUndefined()
  })

  it('seeds an empty composer model from global but never clobbers a pick', async () => {
    vi.mocked(getGlobalModelInfo).mockResolvedValue({ model: 'openai/gpt-5.5', provider: 'openai-codex' })

    const { result } = renderHook(() =>
      useModelControls({
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    // Empty → seeds the default.
    await result.current.refreshCurrentModel()
    expect($currentModel.get()).toBe('openai/gpt-5.5')

    // A user pick must survive the lifecycle refreshes that fire on boot / fresh
    // draft / session events.
    setCurrentModel('anthropic/claude-sonnet-4.6')
    setCurrentModelSource('manual')
    setCurrentProvider('anthropic')
    await result.current.refreshCurrentModel()
    expect($currentModel.get()).toBe('anthropic/claude-sonnet-4.6')

    // A profile swap forces a reseed to the new profile's default.
    await result.current.refreshCurrentModel(true)
    expect($currentModel.get()).toBe('openai/gpt-5.5')
  })

  it('reseeds a sticky manual pick that was removed from the catalog', async () => {
    vi.mocked(getGlobalModelInfo).mockResolvedValue({ model: 'openai/gpt-5.5', provider: 'openai-codex' })

    const queryClient = new QueryClient()
    $activeGatewayProfile.set('compass')
    queryClient.setQueryData(modelOptionsQueryKey('default'), {
      providers: [{ models: ['openrouter/owl-alpha'], name: 'OpenRouter', slug: 'openrouter' }]
    })
    queryClient.setQueryData(modelOptionsQueryKey('compass'), {
      providers: [{ models: ['openai/gpt-5.5'], name: 'OpenRouter', slug: 'openrouter' }]
    })

    // A manual pick whose model no longer exists on its provider.
    setCurrentModel('openrouter/owl-alpha')
    setCurrentProvider('openrouter')
    setCurrentModelSource('manual')

    const { result } = renderHook(() => useModelControls({ queryClient, requestGateway: vi.fn() }))

    await result.current.refreshCurrentModel()

    expect($currentModel.get()).toBe('openai/gpt-5.5')
    expect(getCurrentModelSource()).toBe('default')
  })

  it('keeps a sticky manual pick that is still in the catalog', async () => {
    vi.mocked(getGlobalModelInfo).mockResolvedValue({ model: 'openai/gpt-5.5', provider: 'openai-codex' })

    const queryClient = new QueryClient()
    queryClient.setQueryData(modelOptionsQueryKey('default'), {
      providers: [{ models: ['openrouter/glm-4.7', 'openai/gpt-5.5'], name: 'OpenRouter', slug: 'openrouter' }]
    })

    setCurrentModel('openrouter/glm-4.7')
    setCurrentProvider('openrouter')
    setCurrentModelSource('manual')

    const { result } = renderHook(() => useModelControls({ queryClient, requestGateway: vi.fn() }))

    await result.current.refreshCurrentModel()

    expect($currentModel.get()).toBe('openrouter/glm-4.7')
    expect(getCurrentModelSource()).toBe('manual')
  })

  it('does not let a stale forced profile refresh overwrite a newer picker choice', async () => {
    const profileDefault = deferred<Awaited<ReturnType<typeof getGlobalModelInfo>>>()
    vi.mocked(getGlobalModelInfo).mockReturnValueOnce(profileDefault.promise)

    const { result } = renderHook(() =>
      useModelControls({
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    const pendingRefresh = result.current.refreshCurrentModel(true)
    expect(getGlobalModelInfo).toHaveBeenCalled()

    await expect(
      result.current.selectModel({
        model: 'claude-sonnet-4.6',
        provider: 'anthropic'
      })
    ).resolves.toBe(true)

    profileDefault.resolve({ model: 'gpt-5.5', provider: 'openai-codex' })
    await pendingRefresh

    expect($currentModel.get()).toBe('claude-sonnet-4.6')
    expect($currentProvider.get()).toBe('anthropic')
    expect(getCurrentModelSource()).toBe('manual')
  })

  it('does not let an older profile refresh overwrite a newer profile', async () => {
    const profileB = deferred<Awaited<ReturnType<typeof getGlobalModelInfo>>>()
    const profileC = deferred<Awaited<ReturnType<typeof getGlobalModelInfo>>>()
    vi.mocked(getGlobalModelInfo).mockReturnValueOnce(profileB.promise).mockReturnValueOnce(profileC.promise)

    const { result } = renderHook(() =>
      useModelControls({
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    const refreshB = result.current.refreshCurrentModel(true)
    const refreshC = result.current.refreshCurrentModel(true)

    profileC.resolve({ model: 'profile-c-model', provider: 'profile-c-provider' })
    await refreshC
    profileB.resolve({ model: 'profile-b-model', provider: 'profile-b-provider' })
    await refreshB

    expect($currentModel.get()).toBe('profile-c-model')
    expect($currentProvider.get()).toBe('profile-c-provider')
  })

  it('refreshes legacy/default-derived composer state from the profile default', async () => {
    setCurrentModel('openai/gpt-5.5')
    setCurrentProvider('nous')
    setCurrentModelSource('')
    vi.mocked(getGlobalModelInfo).mockResolvedValue({ model: 'gpt-5.5', provider: 'openai-codex' })

    const { result } = renderHook(() =>
      useModelControls({
        queryClient: new QueryClient(),
        requestGateway: vi.fn()
      })
    )

    expect(getCurrentModelSource()).toBe('')

    await result.current.refreshCurrentModel()

    expect(getGlobalModelInfo).toHaveBeenCalled()
    expect($currentModel.get()).toBe('gpt-5.5')
    expect($currentProvider.get()).toBe('openai-codex')
    expect(getCurrentModelSource()).toBe('default')
  })

  it('targets an explicit tile sessionId without clobbering the primary model', async () => {
    const queryClient = new QueryClient()
    $activeGatewayProfile.set('compass')
    $activeSessionId.set('primary-runtime')
    setCurrentModel('primary/model')
    setCurrentProvider('openai')
    const requestGateway = vi.fn(async () => ({ key: 'model', value: 'tile-model' }) as never)
    const { result } = renderHook(() => useModelControls({ queryClient, requestGateway }))

    await expect(
      result.current.selectModel({
        model: 'tile-model',
        provider: 'anthropic',
        sessionId: 'tile-runtime'
      })
    ).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('config.set', {
      session_id: 'tile-runtime',
      key: 'model',
      value: 'tile-model --provider anthropic --session'
    })
    // Primary footer untouched — the busy primary must not absorb a tile pick.
    expect($currentModel.get()).toBe('primary/model')
    expect($currentProvider.get()).toBe('openai')
    expect(queryClient.getQueryData(modelOptionsQueryKey('compass', 'tile-runtime'))).toMatchObject({
      model: 'tile-model',
      provider: 'anthropic'
    })
    expect(queryClient.getQueryData(modelOptionsQueryKey('default', 'tile-runtime'))).toBeUndefined()
  })

  describe('while the primary session is busy', () => {
    function configSets(requestGateway: ReturnType<typeof vi.fn>) {
      return requestGateway.mock.calls
        .filter(([method]) => method === 'config.set')
        .map(([, params]) => params as Record<string, unknown>)
    }

    async function flush() {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve()
      }
    }

    it('accepts the pick, then lands only the latest one when the turn ends', async () => {
      $activeSessionId.set('runtime-1')
      $busy.set(true)
      const requestGateway = vi.fn().mockResolvedValue({})
      const { result } = renderHook(() => useModelControls({ queryClient: new QueryClient(), requestGateway }))

      await expect(result.current.selectModel({ effort: 'low', model: 'a', provider: 'p' })).resolves.toBe(true)
      await expect(result.current.selectModel({ effort: 'high', model: 'b', provider: 'p' })).resolves.toBe(true)

      expect($currentModel.get()).toBe('b')
      expect(configSets(requestGateway)).toHaveLength(0)

      $busy.set(false)
      await flush()

      const sets = configSets(requestGateway)
      expect(sets.map(params => params.value)).toEqual(['b --provider p --session', 'high'])
      expect(sets.every(params => params.session_id === 'runtime-1')).toBe(true)
      expect($currentModel.get()).toBe('b')
    })

    it('drops the pending pick when the active session changes before the turn ends', async () => {
      $activeSessionId.set('runtime-1')
      $busy.set(true)
      const requestGateway = vi.fn().mockResolvedValue({})
      const { result } = renderHook(() => useModelControls({ queryClient: new QueryClient(), requestGateway }))

      await result.current.selectModel({ model: 'a', provider: 'p' })
      $activeSessionId.set('runtime-2')
      $busy.set(false)
      await flush()

      expect(configSets(requestGateway)).toHaveLength(0)
    })

    it('drops the pending pick when the composer that scheduled it unmounts', async () => {
      $activeSessionId.set('runtime-1')
      $busy.set(true)
      const requestGateway = vi.fn().mockResolvedValue({})
      const { result, unmount } = renderHook(() => useModelControls({ queryClient: new QueryClient(), requestGateway }))

      await result.current.selectModel({ model: 'a', provider: 'p' })
      unmount()
      $busy.set(false)
      await flush()

      expect(configSets(requestGateway)).toHaveLength(0)
    })

    it('keeps the pending pick when a different composer instance unmounts', async () => {
      $activeSessionId.set('runtime-1')
      $busy.set(true)
      const requestGateway = vi.fn().mockResolvedValue({})
      const primary = renderHook(() => useModelControls({ queryClient: new QueryClient(), requestGateway }))
      const tile = renderHook(() => useModelControls({ queryClient: new QueryClient(), requestGateway }))

      await primary.result.current.selectModel({ model: 'a', provider: 'p' })
      tile.unmount()
      $busy.set(false)
      await flush()

      expect(configSets(requestGateway).map(params => params.value)).toEqual(['a --provider p --session'])
    })

    it('reports a deferred failure the way an immediate one is reported', async () => {
      $activeSessionId.set('runtime-1')
      setCurrentModel('before')
      setCurrentProvider('p')
      $busy.set(true)
      const requestGateway = vi.fn().mockRejectedValue(new Error('nope'))
      const { result } = renderHook(() => useModelControls({ queryClient: new QueryClient(), requestGateway }))

      await expect(result.current.selectModel({ model: 'a', provider: 'p' })).resolves.toBe(true)
      expect($currentModel.get()).toBe('a')

      $busy.set(false)
      await flush()

      expect(notifyError).toHaveBeenCalledWith(expect.any(Error), 'Model switch failed')
      expect($currentModel.get()).toBe('before')
    })
  })

  describe('when a newer pick overtakes one still writing', () => {
    it('never writes the stale effort, and never rolls the newer pick back on the stale failure', async () => {
      $activeSessionId.set('runtime-1')
      setCurrentModel('before')
      setCurrentProvider('p')
      const first = deferred<unknown>()
      const requestGateway = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({})
      const { result } = renderHook(() => useModelControls({ queryClient: new QueryClient(), requestGateway }))

      const stale = result.current.selectModel({ effort: 'low', model: 'a', provider: 'p' })
      await expect(result.current.selectModel({ model: 'b', provider: 'p' })).resolves.toBe(true)
      expect($currentModel.get()).toBe('b')

      first.resolve({})
      await expect(stale).resolves.toBe(true)

      const values = requestGateway.mock.calls.map(([, params]) => (params as Record<string, unknown>).value)
      expect(values).toEqual(['a --provider p --session', 'b --provider p --session'])
      expect($currentModel.get()).toBe('b')
    })

    it('leaves the newer pick alone when the stale write fails', async () => {
      notifyError.mockClear()
      $activeSessionId.set('runtime-1')
      setCurrentModel('before')
      setCurrentProvider('p')
      const first = deferred<unknown>()
      const requestGateway = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({})
      const { result } = renderHook(() => useModelControls({ queryClient: new QueryClient(), requestGateway }))

      const stale = result.current.selectModel({ effort: 'low', model: 'a', provider: 'p' })
      await result.current.selectModel({ model: 'b', provider: 'p' })

      first.reject(new Error('nope'))
      await expect(stale).resolves.toBe(false)

      expect($currentModel.get()).toBe('b')
      expect(notifyError).not.toHaveBeenCalled()
      // No best-effort restore of the stale pick's predecessor either.
      const values = requestGateway.mock.calls.map(([, params]) => (params as Record<string, unknown>).value)
      expect(values).toEqual(['a --provider p --session', 'b --provider p --session'])
    })
  })
})
