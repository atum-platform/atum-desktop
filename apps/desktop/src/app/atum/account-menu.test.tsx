import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountStatus } from '@/lib/atum-account-client'
import { clearAtumAppCatalog } from '@/lib/atum-app-catalog'

vi.mock('@/store/atum-messaging', async () => {
  const { atom } = await import('nanostores')

  const $atumAccountStatus = atom<AtumAccountStatus>({
    state: 'signed_in',
    configured: true,
    account: { id: 'account-1', displayName: 'An Example', handle: 'minh', nextHandleChangeAt: '2099-01-15T00:00:00.000Z' },
    errorCode: null,
    providers: { google: true, password: true }
  })

  return {
    $atumAccountScopeId: atom('account-1'),
    $atumAccountStatus,
    refreshAtumAccountStatus: vi.fn(async () => $atumAccountStatus.get()),
    signOutOfAtum: vi.fn()
  }
})

const { LinkedAppsSettings } = await import('./linked-apps-settings')
const { AtumAccountDialog } = await import('./account-menu')
const { $atumAccountStatus, refreshAtumAccountStatus } = await import('@/store/atum-messaging')

const handleAvailability = vi.fn(async () => ({ available: true, reason: null, retryAfterSeconds: null }))
const renameHandle = vi.fn(async (handle: string) => ({ id: 'account-1', displayName: 'An Example', handle }))
const updateProfile = vi.fn(async (input: { displayName: string }) => ({ id: 'account-1', displayName: input.displayName, handle: 'minh' }))
const createAvatarUpload = vi.fn(async () => ({ uploadId: '00000000-0000-4000-8000-6e19e97fb048', uploadUrl: 'https://storage.atum.test/signed', uploadHeaders: { 'content-type': 'image/png' }, expiresAt: '' }))
const completeAvatarUpload = vi.fn(async () => ({ id: 'account-1', displayName: 'An Example', handle: 'minh', avatarUrl: 'https://cdn.atum.test/a.png' }))
const clearAvatar = vi.fn(async () => ({ id: 'account-1', displayName: 'An Example', handle: 'minh', avatarUrl: null }))

/** A stand-in for the signed-URL PUT: records what was sent, succeeds. */
const sentUploads: Array<{ url: string; headers: Record<string, string> }> = []

class FakeUploadRequest {
  static status = 200
  status = 0
  upload = { onprogress: null as null | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) }
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  private url = ''
  private headers: Record<string, string> = {}
  open(_method: string, url: string) { this.url = url }
  setRequestHeader(name: string, value: string) { this.headers[name] = value }
  send() {
    sentUploads.push({ url: this.url, headers: this.headers })
    this.status = FakeUploadRequest.status
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 })
    queueMicrotask(() => this.onload?.())
  }
}

function openDialog() {
  render(
    <AtumAccountDialog>
      <button type="button">Account</button>
    </AtumAccountDialog>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Account' }))
}

beforeEach(() => {
  vi.useRealTimers()
  clearAtumAppCatalog()
  handleAvailability.mockClear()
  renameHandle.mockClear()
  updateProfile.mockClear()
  vi.mocked(refreshAtumAccountStatus).mockClear()
  createAvatarUpload.mockClear()
  completeAvatarUpload.mockClear()
  clearAvatar.mockClear()
  sentUploads.length = 0
  FakeUploadRequest.status = 200
  vi.stubGlobal('XMLHttpRequest', FakeUploadRequest)
  Object.assign(window, {
    hermesDesktop: {
      ...window.hermesDesktop,
      messaging: { ...window.hermesDesktop?.messaging, clearAvatar, completeAvatarUpload, createAvatarUpload, handleAvailability, linkedApps: async () => [], renameHandle, updateProfile }
    }
  })
})

afterEach(cleanup)

describe('AtumAccountDialog', () => {
  it('shows only identity fields the native account contract actually provides', () => {
    render(
      <AtumAccountDialog>
        <button type="button">Account</button>
      </AtumAccountDialog>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))

    expect(screen.getByRole('dialog', { name: 'Your account' })).toBeTruthy()
    // Mock 2c: the name heads the sheet and repeats in the info grid.
    expect(screen.getAllByText('An Example')).toHaveLength(2)
    expect(screen.getAllByText('@minh')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Copy Atum ID' })).toBeTruthy()
    expect(screen.queryByText('Not available')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
    expect((screen.getByRole('button', { name: 'Change photo' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'Remove photo' })).toBeNull()
  })

  it('keeps payment and connection controls out of the profile editor', () => {
    openDialog()
    expect(screen.queryByText('Available to spend')).toBeNull()
    expect(screen.queryByText('Included model usage')).toBeNull()
    expect(screen.queryByText('Linked apps')).toBeNull()
    expect(screen.queryByText('Browser and computer permissions')).toBeNull()
  })

  it('uploads a photo: reserve, PUT the bytes to the signed URL, complete, then re-read the account', async () => {
    openDialog()
    const input = screen.getByLabelText('Change photo') as HTMLInputElement
    const file = new File([new Uint8Array(16)], 'me.png', { type: 'image/png' })

    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(completeAvatarUpload).toHaveBeenCalledWith('00000000-0000-4000-8000-6e19e97fb048'))
    expect(createAvatarUpload).toHaveBeenCalledWith({ contentType: 'image/png' })
    expect(sentUploads).toEqual([{ url: 'https://storage.atum.test/signed', headers: { 'content-type': 'image/png' } }])
    await waitFor(() => expect(refreshAtumAccountStatus).toHaveBeenCalledOnce())
    expect(screen.getByText('JPEG, PNG, or WebP up to 2 MB.')).toBeTruthy()
  })

  it('refuses the wrong type or an oversized photo before spending a reservation', async () => {
    openDialog()
    const input = screen.getByLabelText('Change photo') as HTMLInputElement

    fireEvent.change(input, { target: { files: [new File([new Uint8Array(4)], 'me.gif', { type: 'image/gif' })] } })
    expect(screen.getByRole('alert').textContent).toBe('Choose a JPEG, PNG, or WebP image.')

    const big = new File([new Uint8Array(4)], 'big.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 2_097_153 })
    fireEvent.change(input, { target: { files: [big] } })
    expect(screen.getByRole('alert').textContent).toBe('That photo is over 2 MB. Choose a smaller one.')
    expect(createAvatarUpload).not.toHaveBeenCalled()
  })

  it('reports a failed transfer without touching the profile', async () => {
    FakeUploadRequest.status = 500
    openDialog()

    fireEvent.change(screen.getByLabelText('Change photo'), { target: { files: [new File([new Uint8Array(4)], 'me.png', { type: 'image/png' })] } })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't update your photo. Check your connection and try again."))
    expect(completeAvatarUpload).not.toHaveBeenCalled()
    expect(refreshAtumAccountStatus).not.toHaveBeenCalled()
  })

  it('removes an existing photo and re-reads the account', async () => {
    const current = $atumAccountStatus.get()
    $atumAccountStatus.set({ ...current, account: { ...current.account!, avatarUrl: 'https://cdn.atum.test/a.png' } })
    openDialog()

    expect(globalThis.document.querySelector('img[data-atum-account-avatar]')?.getAttribute('src')).toBe('https://cdn.atum.test/a.png')
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }))

    await waitFor(() => expect(clearAvatar).toHaveBeenCalledOnce())
    await waitFor(() => expect(refreshAtumAccountStatus).toHaveBeenCalledOnce())
    $atumAccountStatus.set(current)
  })

  it('edits the display name through the hosted profile route and re-reads the account status', async () => {
    openDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }))
    const input = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(input, { target: { value: '  Nguyễn An  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ displayName: 'Nguyễn An' }))
    await waitFor(() => expect(refreshAtumAccountStatus).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())
  })

  it('refuses an empty name without calling the plane', () => {
    openDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: '   ' } })

    expect((screen.getByRole('button', { name: 'Save name' }) as HTMLButtonElement).disabled).toBe(true)
    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('recognises the current username without asking the plane and shows the next allowed change', async () => {
    openDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Change username' }))

    expect(screen.getByText('This is already your username.')).toBeTruthy()
    expect(screen.getByText(/You can change it again on/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save username' }) as HTMLButtonElement).disabled).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(handleAvailability).not.toHaveBeenCalled()
  })

  it('claims an available username, then renders the plane-refreshed identity rather than a remembered value', async () => {
    openDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Change username' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Username' }), { target: { value: '@Minh-Anh' } })

    await waitFor(() => expect(handleAvailability).toHaveBeenCalledWith('minh-anh'))
    await waitFor(() => expect(screen.getByText('This name is available.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Save username' }))

    await waitFor(() => expect(renameHandle).toHaveBeenCalledWith('minh-anh'))
    await waitFor(() => expect(refreshAtumAccountStatus).toHaveBeenCalledOnce())
    expect(screen.getByText("Done. You're @minh-anh.")).toBeTruthy()
  })

  it('maps a plane rejection to the matching username state', async () => {
    renameHandle.mockRejectedValueOnce(new Error('handle_cooldown'))
    openDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Change username' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Username' }), { target: { value: 'minh-anh' } })
    await waitFor(() => expect(screen.getByText('This name is available.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Save username' }))

    await waitFor(() => expect(screen.getByText('You can only change your name once every 30 days.')).toBeTruthy())
    expect(refreshAtumAccountStatus).not.toHaveBeenCalled()
    expect($atumAccountStatus.get().account?.handle).toBe('minh')
  })
})

it('reports server withdrawal and local cleanup separately, then retries without a second confirmation', async () => {
  const disconnectApp = vi.fn()
    .mockResolvedValueOnce({ localCleanup: 'unconfirmed' })
    .mockResolvedValueOnce({ localCleanup: 'complete' })

  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  Object.assign(window.hermesDesktop!.messaging!, { linkedApps: async () => [{ app: 'moon', displayName: 'Moon' }], disconnectApp })
  Object.assign(window.hermesDesktop!, { appSurface: { connectStatus: async () => ({ status: 'unlinked', cleanup: 'pending' }) } })
  render(<LinkedAppsSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
  expect(await screen.findByText(/Local app data could not be cleared/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
  expect(screen.queryByText(/Couldn.t disconnect/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry local cleanup' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry local cleanup' })).toBeNull())
  expect(disconnectApp).toHaveBeenCalledTimes(2)
  expect(confirm).toHaveBeenCalledTimes(1)
  confirm.mockRestore()
})

it('uses the server catalog for an unfamiliar linked app in Settings', async () => {
  Object.assign(window.hermesDesktop!, { appSurface: { catalog: async () => ({ apps: [{
    app: 'atlas', app_id: 'atlas-id', app_version_id: 'atlas-version',
    name: { en: 'Atlas', vi: 'Atlas' }, subtitle: null,
    icon: { url: 'https://cdn.atum.test/atlas.png', sha256: 'a'.repeat(64) }, verified: true,
    availability: 'available', supported_modes: ['direct'], link: { mode: 'external_account', state: 'linked' }
  }] }) } })
  Object.assign(window.hermesDesktop!.messaging!, { linkedApps: async () => [{ app: 'atlas', displayName: 'Atlas' }] })
  render(<LinkedAppsSettings />)
  expect(await screen.findByText('Atlas')).toBeTruthy()
  await waitFor(() => expect(document.querySelector('img[src="https://cdn.atum.test/atlas.png"]')).toBeTruthy())
})
