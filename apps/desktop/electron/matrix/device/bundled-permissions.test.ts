import { readFile, stat, writeFile } from 'node:fs/promises'

import { expect, it } from 'vitest'

import { requestBundledPermissions } from './bundled-permissions'

it('uses absolute bundled LaunchServices host and private result protocol', async () => {
  let resultFile = ''

  const status = await requestBundledPermissions('/fixture/Atum.app/Contents/Resources/CuaDriver.app', new AbortController().signal, async args => {
    expect(args.slice(0, 6)).toEqual(['-n', '-W', '-g', '/fixture/Atum.app/Contents/Resources/CuaDriver.app', '--args', '__permissions-host-request'])
    resultFile = args[7]!
    expect((await stat(resultFile)).mode & 0o777).toBe(0o600)
    await writeFile(resultFile, JSON.stringify({ structuredContent: { accessibility: true, screen_recording: true } }))
  })

  expect(status.accessibility).toBe(true)
  await expect(readFile(resultFile)).rejects.toThrow()
})
it('surfaces LaunchServices failure and cancellation', async () => {
  await expect(requestBundledPermissions('/fixture/CuaDriver.app', new AbortController().signal, async () => { throw Error('launch failed') })).rejects.toThrow('launch failed')
})
