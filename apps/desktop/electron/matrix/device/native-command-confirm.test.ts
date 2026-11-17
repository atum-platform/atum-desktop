import { describe, expect, it, vi } from 'vitest'

import { matrixNativeCommandSheetText } from '../../../shared/matrix-native-mac'

import { confirmNativeCommand, type NativeCommandConfirmDeps } from './native-command-confirm'

function deps(overrides: Partial<NativeCommandConfirmDeps> = {}) {
  const prompt = vi.fn(async () => undefined)
  const password = vi.fn(async () => undefined)

  return {
    prompt,
    password,
    value: { touchId: { can: () => true, prompt }, password, locale: () => 'en', ...overrides }
  }
}

describe('fresh native presence', () => {
  it('prompts Touch ID on every approval with the command and no fallback after cancellation', async () => {
    const run = deps()
    await expect(confirmNativeCommand('ls', run.value)).resolves.toBe('confirmed')
    await expect(confirmNativeCommand('ls', run.value)).resolves.toBe('confirmed')
    expect(run.prompt).toHaveBeenCalledTimes(2)
    expect(run.prompt).toHaveBeenCalledWith(expect.stringContaining('“ls”'))
    run.prompt.mockRejectedValueOnce(new Error('cancelled'))
    await expect(confirmNativeCommand('ls', run.value)).resolves.toBe('declined')
    expect(run.password).not.toHaveBeenCalled()
  })
  it('uses the native password presence check only without Touch ID', async () => {
    const run = deps({ touchId: { can: () => false, prompt: vi.fn() } })
    await expect(confirmNativeCommand('ls', run.value)).resolves.toBe('confirmed')
    expect(run.password).toHaveBeenCalledOnce()
    run.password.mockRejectedValueOnce(new Error('cancelled'))
    await expect(confirmNativeCommand('ls', run.value)).resolves.toBe('declined')
  })
  it('bounds IPC and speaks the owner’s language', async () => {
    const run = deps({ locale: () => 'vi' })

    for (const command of ['', {}, 'x'.repeat(16_001)]) {
      await expect(confirmNativeCommand(command, run.value)).rejects.toThrow('invalid_native_command')
    }

    await confirmNativeCommand('ls', run.value)
    expect(run.prompt).toHaveBeenCalledWith(expect.stringContaining('trên máy Mac này'))
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
