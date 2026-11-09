import { link, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { saveUserSelectedFile } from './user-selected-file-save'

describe('saveUserSelectedFile', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'atum-user-save-'))
  })

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true })
  })

  it('replaces an existing destination after the complete body is durable', async () => {
    const target = path.join(directory, 'report.bin')

    await writeFile(target, 'old content')
    await saveUserSelectedFile(target, Buffer.from('new content'))

    await expect(readFile(target, 'utf8')).resolves.toBe('new content')
    await expect(readdir(directory)).resolves.toEqual(['report.bin'])
  })

  it('completes short writes before publishing the destination', async () => {
    const target = path.join(directory, 'report.bin')

    await writeFile(target, 'old content')
    await saveUserSelectedFile(target, Buffer.from('complete replacement'), {
      writeChunk: async (file, bytes, offset) => {
        const length = Math.min(3, bytes.byteLength - offset)
        const { bytesWritten } = await file.write(bytes, offset, length, null)

        return bytesWritten
      }
    })

    await expect(readFile(target, 'utf8')).resolves.toBe('complete replacement')
    await expect(readdir(directory)).resolves.toEqual(['report.bin'])
  })

  it('keeps the original intact and removes its temp file after a partial write fails', async () => {
    const target = path.join(directory, 'report.bin')
    const original = Buffer.from('old content that must survive')

    await writeFile(target, original)

    await expect(saveUserSelectedFile(target, Buffer.alloc(4096, 0x61), {
      writeChunk: async (file, bytes, offset) => {
        await file.write(bytes, offset, 1024, null)
        throw new Error('forced write failure')
      }
    })).rejects.toThrow('forced write failure')

    await expect(readFile(target)).resolves.toEqual(original)
    await expect(readdir(directory)).resolves.toEqual(['report.bin'])
  })

  it("replaces only the selected hard link's directory entry", async () => {
    const target = path.join(directory, 'report.bin')
    const otherLink = path.join(directory, 'other-link.bin')

    await writeFile(target, 'old shared content')
    await link(target, otherLink)
    await saveUserSelectedFile(target, Buffer.from('new private content'))

    await expect(readFile(target, 'utf8')).resolves.toBe('new private content')
    await expect(readFile(otherLink, 'utf8')).resolves.toBe('old shared content')
    await expect(readdir(directory)).resolves.toEqual(['other-link.bin', 'report.bin'])
  })
})
