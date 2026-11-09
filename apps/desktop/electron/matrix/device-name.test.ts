import { describe, expect, it } from 'vitest'

import { matrixDeviceName, readMatrixMacModel } from './device-name'

describe('the name this Mac’s device carries for the person’s other devices', () => {
  it('is Atum and the Mac’s model, never a raw ID or anything personal', () => {
    expect(matrixDeviceName('MacBook Air')).toBe('Atum · MacBook Air')
    expect(matrixDeviceName('Mac mini')).toBe('Atum · Mac mini')
    expect(matrixDeviceName(undefined)).toBe('Atum · Mac')
    expect(matrixDeviceName('  ')).toBe('Atum · Mac')
    expect(matrixDeviceName('Mac\u0000Pro')).toBe('Atum · MacPro')
    expect(matrixDeviceName('x'.repeat(200)).length).toBeLessThanOrEqual(67)
  })

  it('reads the model from System Information, and gives up quietly', async () => {
    const answer = (stdout: string, error: Error | null = null) =>
      ((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        callback(error, stdout)
      }) as never

    if (process.platform === 'darwin') {
      expect(await readMatrixMacModel(answer('{"SPHardwareDataType":[{"machine_name":"MacBook Air"}]}'))).toBe(
        'MacBook Air'
      )
      expect(await readMatrixMacModel(answer('not json'))).toBeUndefined()
      expect(await readMatrixMacModel(answer('', new Error('timeout')))).toBeUndefined()
      expect(await readMatrixMacModel(answer('{"SPHardwareDataType":[{}]}'))).toBeUndefined()
    } else {
      expect(await readMatrixMacModel(answer('{}'))).toBeUndefined()
    }
  })
})
