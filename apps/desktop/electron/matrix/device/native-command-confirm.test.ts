import { describe, expect, it, vi } from 'vitest'

import { matrixNativeCommandSheetText } from '../../../shared/matrix-native-mac'

import { DeviceKeyError } from './device-key'
import { confirmNativeCommand, type NativeCommandConfirmDeps } from './native-command-confirm'

function deps(overrides: Partial<NativeCommandConfirmDeps> = {}) {
  const approve = vi.fn(async (_bytes: Uint8Array, _reason: string) => ({ kid: 'k', sig: 's' }))
  const prompt = vi.fn(async () => undefined)
  const setPaused = vi.fn()

  return {
    approve,
    prompt,
    setPaused,
    value: {
      signer: () => ({ approve }),
      touchId: { can: () => true, prompt },
      locale: () => 'en',
      setPaused,
      ...overrides
    } satisfies NativeCommandConfirmDeps
  }
}

describe('Touch ID before a native command approval', () => {
  it("asks with the device approval key, naming the command, and pauses the Mac's GUI meanwhile", async () => {
    const run = deps()

    await expect(confirmNativeCommand('rm -rf ~/old', run.value)).resolves.toBe('confirmed')

    const [bytes, reason] = run.approve.mock.calls[0] as unknown as [Uint8Array, string]
    expect(Buffer.from(bytes).toString('latin1').startsWith('atum.native-command-confirm/1\0')).toBe(true)
    expect(reason).toContain('“rm -rf ~/old”')
    expect(run.prompt).not.toHaveBeenCalled()
    expect(run.setPaused.mock.calls).toEqual([[true], [false]])
  })

  it('a cancelled or timed-out sheet is a no, never a second prompt', async () => {
    const run = deps()
    run.approve.mockRejectedValueOnce(new DeviceKeyError('approval_denied'))

    await expect(confirmNativeCommand('ls', run.value)).resolves.toBe('declined')
    expect(run.prompt).not.toHaveBeenCalled()
    expect(run.setPaused).toHaveBeenLastCalledWith(false)
  })

  it("falls back to Electron's Touch ID only when the Mac has no approval key", async () => {
    const run = deps()
    run.approve.mockRejectedValueOnce(new DeviceKeyError('approval_unavailable'))

    await expect(confirmNativeCommand('ls', run.value)).resolves.toBe('confirmed')
    expect(run.prompt).toHaveBeenCalledTimes(1)

    const unenrolled = deps({ signer: () => null })
    unenrolled.prompt.mockRejectedValueOnce(new Error('cancelled'))
    await expect(confirmNativeCommand('ls', unenrolled.value)).resolves.toBe('declined')
  })

  it('is unavailable where nothing can ask', async () => {
    const run = deps({ signer: () => null, touchId: { can: () => false, prompt: vi.fn() } })

    await expect(confirmNativeCommand('ls', run.value)).resolves.toBe('unavailable')
  })

  it('refuses anything but a bounded command', async () => {
    const run = deps()

    await expect(confirmNativeCommand('', run.value)).rejects.toThrow('invalid_native_command')
    await expect(confirmNativeCommand({ command: 'ls' }, run.value)).rejects.toThrow('invalid_native_command')
    await expect(confirmNativeCommand('x'.repeat(16_001), run.value)).rejects.toThrow('invalid_native_command')
    expect(run.approve).not.toHaveBeenCalled()
  })

  it('speaks the owner’s language on the sheet', async () => {
    const run = deps({ locale: () => 'vi' })

    await confirmNativeCommand('ls', run.value)

    expect(run.approve.mock.calls[0]?.[1]).toContain('trên máy Mac này')
  })
})

describe('the command on the system sheet', () => {
  it('is one plain line, cut with an ellipsis', () => {
    expect(matrixNativeCommandSheetText('echo a\n\techo b')).toBe('echo a echo b')
    const long = matrixNativeCommandSheetText('a'.repeat(200))
    expect(Array.from(long)).toHaveLength(80)
    expect(long.endsWith('…')).toBe(true)
  })
})
