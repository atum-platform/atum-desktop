import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { stageGoogleClient } from './stage-google-client.mjs'

const directories = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atum-stage-google-client-'))
  directories.push(root)
  const source = path.join(root, 'assets', 'google-desktop-client.json')
  const output = path.join(root, 'dist-matrix', 'assets', 'google-desktop-client.json')
  return { source, output }
}

const validClient = JSON.stringify({
  installed: {
    client_id: 'matrix.apps.googleusercontent.com',
    client_secret: 'desktop-public-client-configuration'
  }
})

it('removes a stale staged client when development or CI has no configured client', async () => {
  const { source, output } = await fixture()
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, validClient)

  expect(stageGoogleClient({ source, output })).toBe(false)
  await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a malformed configured client without staging it', async () => {
  const { source, output } = await fixture()
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, '{')

  expect(() => stageGoogleClient({ source, output })).toThrow('Google OAuth registration')
  await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('stages a valid installed-app client at Matrix app.asar assets path', async () => {
  const { source, output } = await fixture()
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, validClient)

  expect(stageGoogleClient({ source, output })).toBe(true)
  expect(await readFile(output, 'utf8')).toBe(validClient)
})
