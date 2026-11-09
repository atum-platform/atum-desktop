import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { $atumShellEnabled } from '@/store/atum-shell'
import { $visibleModels } from '@/store/model-visibility'
import { $collapsedProviders, toggleCollapsedProvider } from '@/store/provider-collapse'
import {
  $activeSessionId,
  $currentModel,
  $currentModelSource,
  $currentProvider,
  setCurrentModelSource,
  setCurrentReasoningEffort
} from '@/store/session'

import { ModelMenuPanel } from './model-menu-panel'

// Radix calls these on open; jsdom doesn't implement them.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const getGlobalModelOptions = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: (...args: unknown[]) => getGlobalModelOptions(...args),
  setApiRequestProfile: vi.fn()
}))

// MoA presets now arrive as the catalog's virtual `moa` provider row (the same
// payload a remote gateway's model.options returns), not the /api/model/moa
// REST config.
const MOA_PROVIDER = { models: ['default', 'BeastMode'], name: 'Mixture of Agents', slug: 'moa' }

const DEEPSEEK_PROVIDER = {
  models: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  name: 'DeepSeek',
  slug: 'deepseek'
}

const GOOGLE_PROVIDER = {
  models: ['gemini-3.1-pro', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  name: 'Google',
  slug: 'google'
}

const ATUM_PROVIDER = {
  models: ['binh-minh', 'nguyet-thuc', 'nhat-thuc'],
  name: 'Atum',
  slug: 'atum-managed'
}

const MOCK_PROVIDERS = [ATUM_PROVIDER, DEEPSEEK_PROVIDER, GOOGLE_PROVIDER, MOA_PROVIDER]

beforeEach(() => {
  $atumShellEnabled.set(false)
  $activeSessionId.set('runtime-1')
  $currentModel.set('')
  $currentProvider.set('')
  setCurrentModelSource('')
  setCurrentReasoningEffort('medium')
  $collapsedProviders.set([])
  $visibleModels.set(null)
  getGlobalModelOptions.mockResolvedValue({ providers: MOCK_PROVIDERS })
})

/**
 * The Atum menu opens on the slider; the model list is a second view behind
 * the header. Step into it before looking for a model row.
 */
async function openModelList(content: ReturnType<typeof renderPanel>['content']) {
  const header = await content.findByTestId('atum-model-menu-open-models')
  // The header is disabled while the catalog is still loading; clicking then
  // would silently do nothing and the list lookup would time out.
  await waitFor(() => expect(header.hasAttribute('disabled')).toBe(false))
  await act(async () => { fireEvent.click(header) })

  return header
}

describe('Atum compact model menu', () => {
  it('keeps the consumer surface bounded with an advanced escape', async () => {
    $atumShellEnabled.set(true)
    const { content } = renderPanel()

    await content.findByTestId('atum-model-slider')
    // The everyday view is the slider alone — no competing radio list.
    expect(content.queryAllByRole('menuitemradio').length).toBe(0)
    await openModelList(content)
    expect(content.getAllByText('Bình Minh 1.1').length).toBeGreaterThan(0)
    expect(content.getAllByText('Nguyệt Thực 1.0').length).toBeGreaterThan(0)
    expect(content.getAllByText('Nhật Thực 1.0').length).toBeGreaterThan(0)
    expect(content.queryByText('Deepseek V4 Pro')).toBeNull()
    expect(content.queryByRole('textbox', { name: 'Search models' })).toBeNull()
    expect(content.queryAllByRole('menuitem').length).toBeLessThanOrEqual(8)
  })

  it('opens in Default mode without changing an active manual selection', async () => {
    $atumShellEnabled.set(true)
    $currentModel.set('nguyet-thuc')
    $currentProvider.set('atum-managed')
    setCurrentModelSource('manual')
    const { content, onSelectModel } = renderPanel()

    await openModelList(content)
    expect((await content.findByRole('menuitemradio', { name: 'Default' })).getAttribute('aria-checked')).toBe('true')
    expect(onSelectModel).not.toHaveBeenCalled()
    expect($currentModel.get()).toBe('nguyet-thuc')
    expect($currentModelSource.get()).toBe('manual')
  })

  it('locks a named model while the slider changes only its advertised thinking levels', async () => {
    $atumShellEnabled.set(true)
    $currentModel.set('binh-minh')
    $currentProvider.set('atum-managed')
    setCurrentReasoningEffort('low')
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [{
      ...ATUM_PROVIDER,
      capabilities: {
        'binh-minh': { efforts: ['low', 'high'], reasoning: true, fast: false },
        'nguyet-thuc': { efforts: ['max', 'low', 'high'], reasoning: true, fast: false }
      }
    }] })
    const { content, onSelectModel } = renderPanel()
    await openModelList(content)
    await act(async () => { fireEvent.click(await content.findByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' })) })
    // Picking a model returns to the slider; reopen the list to read its state.
    await openModelList(content)
    await waitFor(() =>
      expect(content.getByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' }).getAttribute('aria-checked')).toBe('true')
    )
    expect(onSelectModel).toHaveBeenLastCalledWith({ model: 'nguyet-thuc', provider: 'atum-managed', effort: 'low', sessionId: 'runtime-1' })
    onSelectModel.mockClear()
    await act(async () => { fireEvent.click(content.getByTestId('atum-model-menu-back')) })

    await act(async () => { fireEvent.change(content.getByRole('slider'), { target: { value: '2' } }) })
    await waitFor(() => expect(onSelectModel).toHaveBeenLastCalledWith({ model: 'nguyet-thuc', provider: 'atum-managed', effort: 'max', sessionId: 'runtime-1' }))
    await waitFor(() => expect(content.getByRole('slider').hasAttribute('disabled')).toBe(false))

    await openModelList(content)
    await act(async () => { fireEvent.click(content.getByRole('menuitemradio', { name: 'Default' })) })
    await openModelList(content)
    await waitFor(() =>
      expect(content.getByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' }).getAttribute('aria-checked')).toBe('false')
    )
    await act(async () => { fireEvent.click(content.getByTestId('atum-model-menu-back')) })
    await act(async () => { fireEvent.change(content.getByRole('slider'), { target: { value: '1' } }) })
    await waitFor(() => expect(onSelectModel).toHaveBeenLastCalledWith({ model: 'nguyet-thuc', provider: 'atum-managed', effort: 'high', sessionId: 'runtime-1' }))
  })

  it('returns to Default on reopening without switching the current model', async () => {
    $atumShellEnabled.set(true)
    const first = renderPanel()
    await openModelList(first.content)
    await act(async () => { fireEvent.click(await first.content.findByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' })) })
    await openModelList(first.content)
    expect(first.content.getByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' }).getAttribute('aria-checked')).toBe('true')
    first.content.unmount()

    $currentModel.set('nguyet-thuc')
    const reopened = renderPanel()
    await openModelList(reopened.content)
    expect((await reopened.content.findByRole('menuitemradio', { name: 'Default' })).getAttribute('aria-checked')).toBe('true')
    expect(reopened.onSelectModel).not.toHaveBeenCalled()
    expect($currentModel.get()).toBe('nguyet-thuc')
  })

  it('serializes model rows and slider changes through one pending selection', async () => {
    $atumShellEnabled.set(true)
    let finish!: (value: boolean) => void
    const onSelect = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { content } = renderPanel(onSelect)
    await openModelList(content)
    fireEvent.click(await content.findByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' }))

    // In flight: the list stays put — leaving it would show the slider under
    // the old model — and every row is disabled so a second pick cannot race
    // the first.
    expect(content.getByRole('menuitemradio', { name: 'Default' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(content.getByRole('menuitemradio', { name: 'Bình Minh 1.1' }))
    expect(onSelect).toHaveBeenCalledTimes(1)

    // Landing returns to the slider, so the pick is read back from the list.
    await act(async () => finish(true))
    expect(content.queryAllByRole('menuitemradio').length).toBe(0)
    await openModelList(content)
    expect(content.getByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' }).getAttribute('aria-checked')).toBe('true')
  })

  it('will not leave the model list while a pick is still in flight', async () => {
    $atumShellEnabled.set(true)
    let finish!: (value: boolean) => void
    const onSelect = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { content } = renderPanel(onSelect)
    await openModelList(content)
    fireEvent.click(await content.findByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' }))

    // Back is locked with the rows: leaving here would show the slider under
    // the model the switch is in the middle of replacing.
    const back = content.getByTestId('atum-model-menu-back')
    expect(back.hasAttribute('disabled')).toBe(true)
    fireEvent.click(back)
    expect(content.getByRole('menuitemradio', { name: 'Default' })).toBeTruthy()

    await act(async () => finish(true))
    expect(content.queryAllByRole('menuitemradio').length).toBe(0)
  })

  it('survives being dismissed while a pick is still in flight', async () => {
    $atumShellEnabled.set(true)
    let finish!: (value: boolean) => void
    const onSelect = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { content } = renderPanel(onSelect)
    await openModelList(content)
    fireEvent.click(await content.findByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' }))

    content.unmount()
    // The switch still lands; its continuations must not touch a gone tree.
    await act(async () => finish(true))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('retains Default mode and reports failure when a model switch fails', async () => {
    $atumShellEnabled.set(true)
    const { content } = renderPanel(vi.fn(async () => false))
    await openModelList(content)
    await act(async () => { fireEvent.click(await content.findByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' })) })
    expect(await content.findByText('Model option update failed')).toBeTruthy()
    expect(content.getByRole('menuitemradio', { name: 'Default' }).getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(content.getByTestId('atum-model-menu-back')) })
    expect(content.getByRole('slider').hasAttribute('disabled')).toBe(false)
  })

  it('selects the recommended pair for a draft when Default is clicked', async () => {
    $atumShellEnabled.set(true)
    $activeSessionId.set('')
    $currentModel.set('nguyet-thuc')
    $currentProvider.set('atum-managed')
    setCurrentReasoningEffort('low')
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [{ ...ATUM_PROVIDER,
      capabilities: { 'nguyet-thuc': { efforts: ['low', 'high', 'max'], reasoning: true, fast: false } }
    }] })
    const { content, onSelectModel } = renderPanel()
    await content.findByRole('slider')
    await openModelList(content)
    await act(async () => { fireEvent.click(content.getByRole('menuitemradio', { name: 'Default' })) })
    expect(onSelectModel).toHaveBeenCalledWith({ model: 'nguyet-thuc', provider: 'atum-managed', effort: 'high', sessionId: null })
  })

  it('keeps the fixed-model mode when its thinking update fails', async () => {
    $atumShellEnabled.set(true)
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [{ ...ATUM_PROVIDER,
      capabilities: { 'nguyet-thuc': { efforts: ['low', 'high', 'max'], reasoning: true, fast: false } }
    }] })
    const onSelectModel = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { content } = renderPanel(onSelectModel)
    await openModelList(content)
    await act(async () => { fireEvent.click(await content.findByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' })) })
    await act(async () => { fireEvent.change(content.getByRole('slider'), { target: { value: '2' } }) })
    expect(content.getByText('Model option update failed')).toBeTruthy()
    await openModelList(content)
    expect(content.getByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' }).getAttribute('aria-checked')).toBe('true')
  })

  it('omits stale effort labels for a non-reasoning current model', async () => {
    $atumShellEnabled.set(true)
    $currentModel.set('binh-minh')
    $currentProvider.set('atum-managed')
    setCurrentReasoningEffort('high')
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [{ ...ATUM_PROVIDER,
      capabilities: { 'nguyet-thuc': { efforts: ['low', 'high'], reasoning: true, fast: false } }
    }] })
    const { content } = renderPanel()
    await content.findByRole('slider')
    expect(content.queryByText('Bình Minh 1.1 · High')).toBeNull()
  })

  it('does not select the temporarily unavailable Nhật Thực stop', async () => {
    $atumShellEnabled.set(true)
    const onSelectModel = vi.fn()
    const { content } = renderPanel(onSelectModel)

    const slider = await content.findByRole('slider')
    fireEvent.change(slider, { target: { value: '2' } })

    expect(onSelectModel).not.toHaveBeenCalled()
    expect(await content.findByText('This model is temporarily unavailable.')).toBeTruthy()
    await openModelList(content)
    await act(async () => { fireEvent.click(content.getByRole('menuitemradio', { name: 'Nguyệt Thực 1.0' })) })
    expect(content.queryByText('This model is temporarily unavailable.')).toBeNull()
  })

  it('reports the actual active effort when it sits nearest to a catalog notch', async () => {
    $atumShellEnabled.set(true)
    $currentModel.set('nguyet-thuc')
    $currentProvider.set('atum-managed')
    setCurrentReasoningEffort('medium')
    getGlobalModelOptions.mockResolvedValueOnce({
      model: 'nguyet-thuc',
      provider: 'atum-managed',
      providers: [
        {
          ...ATUM_PROVIDER,
          capabilities: {
            'binh-minh': { efforts: ['low', 'high', 'max'], fast: false, reasoning: true },
            'nguyet-thuc': { efforts: ['low', 'high', 'max'], fast: false, reasoning: true },
            'nhat-thuc': { efforts: ['low', 'high', 'max'], fast: false, reasoning: true }
          }
        }
      ]
    })
    const { content } = renderPanel()

    expect(await content.findByText('Nguyệt Thực 1.0 · Medium')).toBeTruthy()
  })
  it('selects the catalog-advertised model and effort together', async () => {
    $atumShellEnabled.set(true)
    const onSelectModel = vi.fn(async () => true)
    getGlobalModelOptions.mockResolvedValueOnce({
      model: 'binh-minh',
      provider: 'atum-managed',
      providers: [
        {
          ...ATUM_PROVIDER,
          capabilities: {
            'binh-minh': { efforts: ['low', 'high', 'max'], fast: false, reasoning: true },
            'nguyet-thuc': { efforts: ['low', 'high', 'max'], fast: false, reasoning: true },
            'nhat-thuc': { efforts: ['low', 'high', 'max'], fast: false, reasoning: true }
          }
        }
      ]
    })
    const { content } = renderPanel(onSelectModel)

    const slider = await content.findByRole('slider')
    fireEvent.change(slider, { target: { value: '1' } })

    await waitFor(() =>
      expect(onSelectModel).toHaveBeenCalledWith({
        effort: 'high',
        model: 'nguyet-thuc',
        provider: 'atum-managed',
        sessionId: 'runtime-1'
      })
    )
  })
})

describe('Atum advanced model menu', () => {
  it('keeps Nhật Thực visible but disabled', async () => {
    $atumShellEnabled.set(false)
    const { content } = renderPanel()

    const nhatThuc = await content.findByText('Nhật Thực 1.0')

    expect(nhatThuc.closest('[role="menuitem"]')?.getAttribute('data-disabled')).not.toBeNull()
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPanel(onSelectModel = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const content = render(
    <QueryClientProvider client={client}>
      <DropdownMenu open>
        <DropdownMenuContent>
          <ModelMenuPanel onSelectModel={onSelectModel} requestGateway={vi.fn() as never} />
        </DropdownMenuContent>
      </DropdownMenu>
    </QueryClientProvider>
  )

  return { onSelectModel, content }
}

describe('ModelMenuPanel MoA presets', () => {
  it('selecting a MoA preset switches PERSISTENTLY via onSelectModel (not the one-shot dispatch)', async () => {
    const { content, onSelectModel } = renderPanel()

    // moaOptions is async (useQuery) — wait for the preset row to mount.
    const row = await content.findByText('MoA: BeastMode')
    fireEvent.click(row)

    // #54670: must route through the persistent model-switch path
    // i.e. onSelectModel with provider 'moa' (which session-scopes live-session
    // switches), NOT a one-shot command.dispatch that reverts after a turn.
    expect(onSelectModel).toHaveBeenCalledWith({ model: 'BeastMode', provider: 'moa', sessionId: 'runtime-1' })
  })

  it('shows the check on the preset that matches the current moa selection', async () => {
    $currentProvider.set('moa')
    $currentModel.set('BeastMode')
    const { content } = renderPanel()

    const row = await content.findByText('MoA: BeastMode')
    // The check glyph renders as a sibling within the same row item.
    const item = row.closest('[role="menuitem"]') ?? row.parentElement
    expect(item?.querySelector('svg.atum-icon-check')).not.toBeNull()
  })

  it('keeps the virtual moa provider out of the main model groups (presets section only)', async () => {
    const { content } = renderPanel()

    await content.findByText('MoA: BeastMode')

    // The provider group header would read "Mixture of Agents"; the presets
    // section header reads "MoA presets". Only the latter should exist.
    // Radix DropdownMenu portals its content to document.body, so assert
    // against the body (not content.container) to see the rendered items.

    // eslint-disable-next-line no-restricted-globals
    expect(document.body.textContent).toContain('MoA presets')
    // eslint-disable-next-line no-restricted-globals
    expect(document.body.textContent).not.toContain('Mixture of Agents')
  })

  it('renders presets from the catalog even before a session exists', async () => {
    $activeSessionId.set('')
    const { onSelectModel, content } = renderPanel()

    const row = await content.findByText('MoA: BeastMode')
    fireEvent.click(row)

    // Pre-session picks are UI state shipped on the next session.create — the
    // row must not be disabled and must still route through onSelectModel.
    expect(onSelectModel).toHaveBeenCalledWith({ model: 'BeastMode', provider: 'moa', sessionId: null })
  })
})

describe('ModelMenuPanel provider collapse', () => {
  it('shows all provider models by default (none collapsed)', async () => {
    const { content } = renderPanel()

    await content.findByText('DeepSeek')
    expect(content.queryByText('Deepseek V4 Pro')).not.toBeNull()
    expect(content.queryByText('Deepseek Chat')).not.toBeNull()
  })

  it('collapses provider models when header is clicked', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    fireEvent.click(header)

    // Models should disappear but header stays
    expect(content.queryByText('Deepseek V4 Pro')).toBeNull()
    expect(content.queryByText('DeepSeek')).not.toBeNull()
  })

  it('expands provider models when header is clicked again', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    // Collapse
    fireEvent.click(header)
    expect(content.queryByText('Deepseek V4 Pro')).toBeNull()
    // Expand
    fireEvent.click(header)
    await waitFor(() => {
      expect(content.queryByText('Deepseek V4 Pro')).not.toBeNull()
    })
  })

  it('auto-expands the active provider even when collapsed', async () => {
    $currentProvider.set('deepseek')
    $currentModel.set('deepseek-v4-pro')
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    fireEvent.click(header)

    // Should still show models because it's the active provider
    expect(content.queryByText('Deepseek V4 Pro')).not.toBeNull()
  })

  it('bypasses collapse when search is active', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    fireEvent.click(header)
    expect(content.queryByText('Deepseek V4 Pro')).toBeNull()

    // Type in the search bar (auto-focused by DropdownMenuSearch)
    const input = screen.getByRole('textbox', { name: 'Search models' })
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { value: 'deepseek' } })

    // Should show models — search bypasses collapse
    await waitFor(() => {
      expect(content.queryByText('Deepseek V4 Pro')).not.toBeNull()
    })
  })

  it('toggles collapse via keyboard Enter on header', async () => {
    const { content } = renderPanel()

    const header = await content.findByText('DeepSeek')
    // Radix DropdownMenuItem fires onSelect on Enter from the onKeyDown handler
    fireEvent.keyDown(header.closest('[role="menuitem"]') ?? header, { key: 'Enter' })

    expect(content.queryByText('Deepseek V4 Pro')).toBeNull()
  })

  // The collapsed-providers set is a global presentation preference
  // (`hermes.desktop.collapsed-providers`), but the catalog the picker renders
  // is profile-scoped (`getGlobalModelOptions` routes through
  // `profileScoped()`). Pruning the global set against only the active catalog
  // would silently delete a user's collapse preference on every profile switch
  // whose configured providers don't include the slug — the bug the maintainer
  // flagged. The set must survive catalog changes; if the same provider shows
  // up again later, the previous collapse is preserved.
  it('preserves the collapsed set across a profile switch whose catalog lacks the slug', async () => {
    toggleCollapsedProvider('deepseek')
    toggleCollapsedProvider('google')
    expect($collapsedProviders.get()).toEqual(['deepseek', 'google'])

    // Profile A: both providers present, render + unmount.
    getGlobalModelOptions.mockResolvedValueOnce({ providers: MOCK_PROVIDERS })
    const a = renderPanel()
    await a.content.findByText('DeepSeek')
    a.content.unmount()

    // Profile B: google is not in the catalog (simulates a profile whose
    // configured providers differ). The previously-collapsed 'google' slug
    // must survive — pruning it would lose state across a profile switch.
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [DEEPSEEK_PROVIDER, MOA_PROVIDER] })
    const b = renderPanel()
    await b.content.findByText('DeepSeek')

    expect($collapsedProviders.get()).toEqual(['deepseek', 'google'])
  })

  it('preserves the collapsed set when Refresh Models drops a provider', async () => {
    toggleCollapsedProvider('deepseek')
    toggleCollapsedProvider('google')

    // First load: both providers present.
    getGlobalModelOptions.mockResolvedValueOnce({ providers: MOCK_PROVIDERS })
    const a = renderPanel()
    await a.content.findByText('DeepSeek')
    a.content.unmount()

    // Refresh Models returns a catalog that drops google (revoked key,
    // plugin disabled, backend policy change). 'google' must survive — the
    // user explicitly collapsed it, and the global set is not tied to any
    // single refresh.
    getGlobalModelOptions.mockResolvedValueOnce({ providers: [DEEPSEEK_PROVIDER, MOA_PROVIDER] })
    const b = renderPanel()
    await b.content.findByText('DeepSeek')

    expect($collapsedProviders.get()).toContain('google')
    expect($collapsedProviders.get()).toContain('deepseek')
  })
})
