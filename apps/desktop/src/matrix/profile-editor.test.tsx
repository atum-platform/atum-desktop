import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { vi as vietnamese } from '@/i18n/vi'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

import type { MatrixUiBridge } from '../../shared/matrix'
import type { MatrixProfile, MatrixProfilesBridge, MatrixProfileTarget } from '../../shared/matrix-profile'

import { MatrixProfileEditor } from './profile-editor'

const a = '00000000-0000-4000-8000-bd7662a5eeb4'
const b = '00000000-0000-4000-8000-b454f82c5857'
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const photoUrl = 'data:image/png;base64,iVBORw0KGgo='
const person: MatrixProfile = { userId: '@human:test', displayName: 'Minh', avatarMxc: null, avatarUrl: null }

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:local-preview') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
  vi.unstubAllGlobals()
})

function fixture(locale: Locale = 'en', target: MatrixProfileTarget = { kind: 'human' }, name = 'Minh') {
  const profiles = {
    open: vi.fn<MatrixProfilesBridge['open']>().mockResolvedValue({ scope: 'editor-scope' }),
    read: vi.fn<MatrixProfilesBridge['read']>().mockResolvedValue(person),
    change: vi
      .fn<MatrixProfilesBridge['change']>()
      .mockResolvedValue({ ...person, avatarMxc: 'mxc://matrix.test/photo', avatarUrl: photoUrl }),
    close: vi.fn<MatrixProfilesBridge['close']>().mockResolvedValue(undefined)
  }

  window.atumMatrix = { profiles } as unknown as MatrixUiBridge
  const onOpenChange = vi.fn()

  const content = (target: MatrixProfileTarget, name: string, scopeKey = 'human/MAC') => (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixProfileEditor name={name} onOpenChange={onOpenChange} open scopeKey={scopeKey} target={target} />
    </I18nProvider>
  )

  const view = render(content(target, name))

  return {
    ...view,
    profiles,
    onOpenChange,
    rerenderEditor: (target: MatrixProfileTarget, name: string, scopeKey?: string) =>
      view.rerender(content(target, name, scopeKey))
  }
}

function file(type = 'image/png', bytes = png) {
  const value = new File([new Uint8Array(bytes)], 'private-original-name.png', { type })
  Object.defineProperty(value, 'arrayBuffer', {
    configurable: true,
    value: vi.fn(async () => new Uint8Array(bytes).buffer)
  })

  return value
}

async function choose(value: File, label = 'Photo') {
  await waitFor(() => expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(false))
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { files: [value] } })
  })
}

it('uses the existing 520px glass photo editor and scoped replace/remove, without a symbol picker', async () => {
  const f = fixture()
  await choose(file())
  await waitFor(() =>
    expect(f.profiles.change).toHaveBeenCalledWith('editor-scope', { kind: 'replace', type: 'image/png', bytes: png })
  )
  await waitFor(() => expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(photoUrl))
  expect(screen.getByRole('dialog').className).toContain('max-w-[520px]')
  expect(screen.queryByText('Symbol')).toBeNull()
  f.profiles.change.mockResolvedValueOnce(person)
  fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }))
  await waitFor(() => expect(f.profiles.change).toHaveBeenLastCalledWith('editor-scope', { kind: 'remove' }))
  await waitFor(() => expect(screen.getByRole('dialog').querySelector('img')).toBeNull())
  expect(screen.getByText('M')).toBeTruthy()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview')
})

it('uses a first grapheme for every agent, including Atum, rather than a branded preset', async () => {
  const f = fixture('en', { kind: 'agent', principal: a }, 'Atum')
  expect(screen.getByText('A')).toBeTruthy()
  expect(screen.getByRole('dialog').querySelector('img')).toBeNull()
  f.rerenderEditor({ kind: 'agent', principal: b }, '👩🏽‍💻 Studio')
  expect(screen.getByText('👩🏽‍💻')).toBeTruthy()
  await waitFor(() => expect(f.profiles.close).toHaveBeenCalledWith('editor-scope'))
})

it.each([
  ['en', en],
  ['vi', vietnamese],
  ['ja', ja],
  ['zh', zh],
  ['zh-hant', zhHant]
] as const)('retains existing localized photo validation and actions in %s', async (locale, translations) => {
  const f = fixture(locale)
  const copy = translations.atum.account
  await choose(file('image/svg+xml'), copy.photo)
  expect(screen.getByRole('alert').textContent).toContain(copy.photoWrongType)
  expect(f.profiles.change).not.toHaveBeenCalled()
  await choose(file('image/png', new Uint8Array(2 * 1024 * 1024 + 1)), copy.photo)
  expect(screen.getByRole('alert').textContent).toContain(copy.photoTooLarge)
  expect(f.profiles.change).not.toHaveBeenCalled()
  expect((screen.getByLabelText(copy.photo) as HTMLInputElement).accept).toBe('image/jpeg,image/png,image/webp')
})

it('retries a failed photo operation only in its existing editor scope, without creating an agent', async () => {
  const f = fixture('en', { kind: 'agent', principal: a }, 'Atum')
  f.profiles.change.mockRejectedValueOnce(new Error('synthetic failure'))
  await choose(file())
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Retry photo' }))
  await waitFor(() => expect(f.profiles.change).toHaveBeenCalledTimes(2))
  expect(f.profiles.change.mock.calls[0]).toEqual(f.profiles.change.mock.calls[1])
  expect(f.profiles.open).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps an in-flight editor across same-account snapshots without reopening or discarding it', async () => {
  const f = fixture()
  let finish!: (profile: MatrixProfile) => void
  f.profiles.change.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  await choose(file())
  await waitFor(() => expect(f.profiles.change).toHaveBeenCalledOnce())
  f.rerenderEditor({ kind: 'human' }, 'Minh')
  f.rerenderEditor({ kind: 'human' }, 'Minh')
  expect(f.profiles.open).toHaveBeenCalledOnce()
  expect(f.profiles.close).not.toHaveBeenCalled()
  await act(async () => finish({ ...person, avatarMxc: 'mxc://matrix.test/current', avatarUrl: photoUrl }))
  expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(photoUrl)
})

it('retires the previous editor on a native generation change for the same human and device', async () => {
  const f = fixture()
  await waitFor(() => expect(f.profiles.read).toHaveBeenCalledOnce())
  let finish!: (profile: MatrixProfile) => void
  f.profiles.change.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  await choose(file())
  await waitFor(() => expect(f.profiles.change).toHaveBeenCalledOnce())
  f.rerenderEditor({ kind: 'human' }, 'Minh', 'human/MAC/generation-2')
  expect(f.profiles.close).toHaveBeenCalledWith('editor-scope')
  await waitFor(() => expect(f.profiles.open).toHaveBeenCalledTimes(2))
  await act(async () => finish({ ...person, avatarMxc: 'mxc://matrix.test/retired', avatarUrl: photoUrl }))
  expect(screen.getByRole('dialog').querySelector('img')).toBeNull()
})

it('does not send bytes that finish reading after agent switch, even A → B → A', async () => {
  const f = fixture('en', { kind: 'agent', principal: a }, 'Atum')
  const image = file()
  let finish!: (bytes: ArrayBuffer) => void
  Object.defineProperty(image, 'arrayBuffer', {
    configurable: true,
    value: () =>
      new Promise<ArrayBuffer>(resolve => {
        finish = resolve
      })
  })
  await choose(image)
  f.rerenderEditor({ kind: 'agent', principal: b }, 'Studio')
  f.rerenderEditor({ kind: 'agent', principal: a }, 'Atum')
  await act(async () => finish(new Uint8Array(png).buffer))
  expect(f.profiles.change).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog').querySelector('img')).toBeNull()
})

it('closes the native scope immediately on close and ignores a late operation result after account switch', async () => {
  const f = fixture()
  let finish!: (profile: MatrixProfile) => void
  f.profiles.change.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  await choose(file())
  await waitFor(() => expect(f.profiles.change).toHaveBeenCalledOnce())
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
  expect(f.profiles.close).toHaveBeenCalledWith('editor-scope')
  f.rerenderEditor({ kind: 'human' }, 'New person', 'other/MAC')
  await act(async () => finish({ ...person, avatarMxc: 'mxc://matrix.test/old-account', avatarUrl: photoUrl }))
  expect(screen.getByRole('dialog').querySelector('img')).toBeNull()
  expect(screen.getByText('N')).toBeTruthy()
})

it('keeps an unavailable old photo removable and a failed initial read retryable', async () => {
  const f = fixture()
  f.profiles.read.mockRejectedValueOnce(new Error('unavailable'))
  f.rerenderEditor({ kind: 'human' }, 'Minh', 'next/MAC')
  await screen.findByRole('alert')
  f.profiles.read.mockResolvedValueOnce({ ...person, avatarMxc: 'mxc://matrix.test/missing', photoUnavailable: true })
  fireEvent.click(screen.getByRole('button', { name: 'Retry photo' }))
  await screen.findByRole('button', { name: 'Remove photo' })
  fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }))
  await waitFor(() => expect(f.profiles.change).toHaveBeenLastCalledWith('editor-scope', { kind: 'remove' }))
})

it('lets the person set their display name with Save, never an agent’s, and closes once saved', async () => {
  const f = fixture()
  f.profiles.change.mockResolvedValueOnce({ ...person, displayName: 'An Example' })
  const field = await screen.findByRole('textbox', { name: 'Display name' })
  await waitFor(() => expect((field as HTMLInputElement).value).toBe('Minh'))
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
  // Unchanged or empty: nothing to save.
  expect(save.disabled).toBe(true)
  fireEvent.change(field, { target: { value: '   ' } })
  expect(save.disabled).toBe(true)
  fireEvent.change(field, { target: { value: '  An Example ' } })
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  await waitFor(() =>
    expect(f.profiles.change).toHaveBeenCalledWith('editor-scope', { kind: 'name', displayName: 'An Example' })
  )
  await waitFor(() => expect(f.onOpenChange).toHaveBeenCalledWith(false))
})

it('keeps the typed name and says so when saving it fails', async () => {
  const f = fixture()
  f.profiles.change.mockRejectedValueOnce(new Error('offline'))
  const field = await screen.findByRole('textbox', { name: 'Display name' })
  await waitFor(() => expect((field as HTMLInputElement).value).toBe('Minh'))
  fireEvent.change(field, { target: { value: 'Minh N.' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('Couldn’t save your name. Check your connection and try again.')).toBeTruthy()
  expect((field as HTMLInputElement).value).toBe('Minh N.')
  expect(f.onOpenChange).not.toHaveBeenCalledWith(false)
})

it('shows a person’s photo round and an assistant’s as its tile, with no name field for an assistant', async () => {
  fixture()
  await screen.findByRole('textbox', { name: 'Display name' })
  expect(screen.getByRole('dialog').querySelector('.size-14')?.className).toContain('rounded-full')
  cleanup()
  fixture('en', { kind: 'agent', principal: a }, 'Atum')
  expect(screen.queryByRole('textbox', { name: 'Display name' })).toBeNull()
  expect(screen.getByRole('dialog').querySelector('.size-14')?.className).not.toContain('rounded-full')
  expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
})
