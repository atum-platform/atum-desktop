import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { saveUserSelectedFile } from '../user-selected-file-save'

import type { MatrixCompanyFileAuthorityResolution } from './company-file-authority-v2'

// Exercise main's actual download dispatch without starting Electron. The save
// itself uses the production helper against a real scratch filesystem.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('./main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true)

let download: ts.IfStatement | undefined

function visit(node: ts.Node) {
  if (ts.isIfStatement(node) && node.expression.getText(source) ===
      "input.kind === 'download' && input.companyFile === true") {
    download = node
  }

  ts.forEachChild(node, visit)
}

visit(source)

if (!download) {throw new Error('Missing protected download dispatch')}

const code = ts.transpileModule(`(async function(input) { ${download.getText(source)} })`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText

const companyId = '00000000-0000-4000-8000-576f18824476'
const channelId = '00000000-0000-4000-8000-95eb2692c90e'
const otherId = '00000000-0000-4000-8000-b4b6412c243e'
const legacy = { kind: 'legacy-public', companyId, channelId } as const

const publicV2 = { kind: 'v2', authority: {
  companyId, audience: { kind: 'channel', channel_id: channelId, visibility: 'public' },
  viewerAdmissionEpoch: 1, audienceGeneration: 1
} } as const

const scratchDirectories = new Set<string>()

afterEach(() => {
  for (const directory of scratchDirectories) {
    rmSync(directory, { force: true, recursive: true })
  }

  scratchDirectories.clear()
})

function fixture(authority: MatrixCompanyFileAuthorityResolution, company = companyId, channel = channelId) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'atum-main-company-download-'))
  const targetPath = path.join(directory, 'report.txt')
  const original = Buffer.from('existing report')

  scratchDirectories.add(directory)
  writeFileSync(targetPath, original)

  const reference = { v: 1, company_id: company, channel_id: channel,
    file_id: '00000000-0000-4000-8000-676a3a34ff0f', revision: 1, name: 'report.txt',
    content_type: 'text/plain', size: 1, sha256: 'a'.repeat(64) }

  const read = vi.fn(async () => ({ name: reference.name, bytes: new Uint8Array([1]) }))
  const save = vi.fn(async () => ({ canceled: false, filePath: targetPath }))

  const invoke = runInNewContext(code, {
    owner: {}, companyFiles: true, teamSpaceRoom: {}, companyRoom: {}, sdkBusy: false,
    state: { state: 'ready' }, account: {}, ui: {}, AbortSignal, Error, path,
    companyFilePortsV2: () => ({ sdk: vi.fn(async () => reference), current: () => true }),
    companyFilePorts: () => ({ pending: () => undefined }),
    resolveCompanyFileAuthorityV2: vi.fn(async () => authority),
    readCompanyFile: read, dialog: { showSaveDialog: save }, saveUserSelectedFile
  })

  return { directory, original, read, save, targetPath,
    invoke: () => invoke({ kind: 'download', companyFile: true, roomId: '!legacy:test', eventId: '$file' }) }
}

describe('main legacy protected download authority', () => {
  it.each([legacy, publicV2])('rejects mismatched company before fetching or saving ($kind)', async authority => {
    const f = fixture(authority, otherId)
    await expect(f.invoke()).rejects.toThrow('matrix_company_file_denied')
    expect(f.read).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
    expect(readFileSync(f.targetPath)).toEqual(f.original)
    expect(readdirSync(f.directory)).toEqual(['report.txt'])
  })

  it.each([legacy, publicV2])('rejects mismatched channel before fetching or saving ($kind)', async authority => {
    const f = fixture(authority, companyId, otherId)
    await expect(f.invoke()).rejects.toThrow('matrix_company_file_denied')
    expect(f.read).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
    expect(readFileSync(f.targetPath)).toEqual(f.original)
    expect(readdirSync(f.directory)).toEqual(['report.txt'])
  })

  it.each([legacy, publicV2])('preserves matching public downloads ($kind)', async authority => {
    const f = fixture(authority)
    await expect(f.invoke()).resolves.toBeNull()
    expect(f.read).toHaveBeenCalledOnce()
    expect(f.save).toHaveBeenCalledOnce()
    expect(readFileSync(f.targetPath)).toEqual(Buffer.from([1]))
    expect(readdirSync(f.directory)).toEqual(['report.txt'])
  })
})
