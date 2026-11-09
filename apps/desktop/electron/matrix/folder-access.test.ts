import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_FOLDER_ACCESS_IPC } from '../../shared/matrix-folder-access'

import {
  type FolderAccessDependencies,
  folderAccessPolicyFile,
  MatrixFolderAccess,
  registerMatrixFolderAccessIpc
} from './folder-access'

const HOME = '/home/example'
const ACCOUNT = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const roots: string[] = []

function errno(code: string) {
  return Object.assign(new Error(code), { code })
}

function setup(overrides: Partial<FolderAccessDependencies> & { answers?: Record<string, string> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'atum-folder-access-'))
  roots.push(root)
  const items = new Map<string, string>()
  const listed: string[] = []
  const answers = overrides.answers ?? {}
  const policyFor = (key: string) => path.join(root, 'source-policy', `${key}.folders.json`)
  const policy = policyFor(ACCOUNT)
  const current = { accountKey: ACCOUNT, generation: 1 }

  const deps: FolderAccessDependencies = {
    storage: { getItem: key => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) },
    scope: () => ({ ...current }),
    platform: 'darwin',
    home: HOME,
    list: async directory => {
      listed.push(directory)
      const answer = answers[path.basename(directory)]

      if (answer) {
        throw errno(answer)
      }
    },
    exists: () => true,
    pick: async () => null,
    // Main resolves a missing key against the account that is current now (the 12cd1b6d78 shape).
    policyFile: (key?: string) => policyFor(key ?? current.accountKey),
    ...overrides
  }

  return { access: new MatrixFolderAccess(deps), listed, policy, policyFor, items, current }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

describe('MatrixFolderAccess', () => {
  it('starts with every folder ticked and never lists a folder just to show it', () => {
    const { access, listed } = setup()

    expect(access.read()).toEqual({
      platform: 'macos',
      folders: [
        { id: 'desktop', kind: 'desktop', shared: true, mac: 'not-asked' },
        { id: 'documents', kind: 'documents', shared: true, mac: 'not-asked' },
        { id: 'downloads', kind: 'downloads', shared: true, mac: 'not-asked' },
        { id: 'icloud', kind: 'icloud', shared: true, mac: 'not-asked' }
      ]
    })
    expect(listed).toEqual([])
  })

  it('asks macOS once per ticked folder, in order, and never for an unticked one', async () => {
    const { access, listed } = setup({ answers: { Downloads: 'EPERM' } })

    const view = await access.apply({ desktop: true, documents: false, downloads: true, icloud: true })

    expect(listed).toEqual([
      `${HOME}/Desktop`,
      `${HOME}/Downloads`,
      `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`
    ])
    expect(view.folders.map(row => [row.id, row.shared, row.mac])).toEqual([
      ['desktop', true, 'granted'],
      ['documents', false, 'not-asked'],
      ['downloads', true, 'denied'],
      ['icloud', true, 'granted']
    ])

    // A granted folder is not asked again; a refused one is asked again when turned on again.
    listed.length = 0
    await access.apply({ desktop: true, downloads: true })
    expect(listed).toEqual([`${HOME}/Downloads`])
  })

  it('one Settings switch asks macOS only for its own folder', async () => {
    // An upgraded account: every folder shared, none asked yet.
    const { access, listed } = setup()

    await access.apply({ documents: false })
    expect(listed).toEqual([])

    await access.apply({ documents: true })
    expect(listed).toEqual([`${HOME}/Documents`])
  })

  it('drops a macOS answer that arrives after the account changed, before writing anything', async () => {
    let release!: () => void

    const { access, current, items, policyFor } = setup({
      list: () => new Promise<void>(resolve => { release = resolve })
    })

    const applying = access.apply({ desktop: true, documents: false })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const before = readFileSync(policyFor(ACCOUNT), 'utf8')

    current.accountKey = OTHER
    current.generation = 2
    release()

    await expect(applying).rejects.toThrow('matrix_folder_access_stale')
    expect(existsSync(policyFor(OTHER))).toBe(false)
    expect(items.has(`matrix-folder-access.${OTHER}`)).toBe(false)
    expect(readFileSync(policyFor(ACCOUNT), 'utf8')).toBe(before)
  })

  it('a change queued behind a prompt keeps the account it was asked for', async () => {
    let release!: () => void

    const { access, current, items, policyFor } = setup({
      list: () => new Promise<void>(resolve => { release = resolve }),
      pick: async () => '/Volumes/Work/Clients'
    })

    const prompting = access.apply({ desktop: true })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const queued = [access.apply({ documents: false }), access.add(), access.remove('added:0')]

    // A → B, then back to A under a new generation: none of A's queued calls may run.
    current.accountKey = OTHER
    current.generation = 2
    // B's own call queues too; it is B's and runs for B once the queue reaches it.
    const forB = access.apply({ downloads: false })
    current.accountKey = ACCOUNT
    current.generation = 3
    release()
    await expect(forB).rejects.toThrow('matrix_folder_access_stale')

    await expect(prompting).rejects.toThrow('matrix_folder_access_stale')

    for (const call of queued) {
      await expect(call).rejects.toThrow('matrix_folder_access_stale')
    }

    const a = JSON.parse(readFileSync(policyFor(ACCOUNT), 'utf8')) as { blocked: string[]; shared: string[] }
    expect(a.blocked).not.toContain(`${HOME}/Documents`)
    expect(a.shared).not.toContain('/Volumes/Work/Clients')
    const b = JSON.parse(items.get(`matrix-folder-access.${OTHER}`) ?? 'null') as { standard: Record<string, { shared: boolean }> } | null
    expect(b?.standard.documents.shared ?? true).toBe(true)
    expect(existsSync(policyFor(OTHER)) ? JSON.parse(readFileSync(policyFor(OTHER), 'utf8')).blocked : []).not.toContain(`${HOME}/Documents`)
  })

  it('never saves a folder picked for one account into another', async () => {
    let choose!: (file: string) => void

    const { access, current, items, policyFor } = setup({
      pick: () => new Promise<string>(resolve => { choose = resolve })
    })

    const adding = access.add()
    await vi.waitFor(() => expect(choose).toBeTypeOf('function'))
    current.accountKey = OTHER
    choose('/Volumes/Work/Clients')

    await expect(adding).rejects.toThrow('matrix_folder_access_stale')
    expect(existsSync(policyFor(OTHER))).toBe(false)
    expect(existsSync(policyFor(ACCOUNT))).toBe(false)
    expect([...items.keys()]).toEqual([])
  })

  it('a damaged record keeps the folders the tools last kept closed, and never reopens them', async () => {
    const { access, items, policy } = setup()

    await access.apply({ documents: false })
    items.set(`matrix-folder-access.${ACCOUNT}`, '{"version":1,"standard":{')

    expect(access.read().folders.map(row => [row.id, row.shared])).toEqual([
      ['desktop', true],
      ['documents', false],
      ['downloads', true],
      ['icloud', true]
    ])
    access.writePolicy()
    expect(JSON.parse(readFileSync(policy, 'utf8')).blocked).toEqual([`${HOME}/Documents`])
  })

  it('a damaged record with no readable policy file closes every folder', () => {
    const unreadable = setup({ storage: { getItem: () => { throw new Error('keychain locked') }, setItem: () => undefined } })

    expect(unreadable.access.read().folders.every(row => !row.shared)).toBe(true)

    const { access, items, policy } = setup()
    items.set(`matrix-folder-access.${ACCOUNT}`, JSON.stringify({ version: 1, standard: { desktop: { shared: 'yes' } }, added: [] }))
    mkdirSync(path.dirname(policy), { recursive: true })
    writeFileSync(policy, 'not json')

    expect(access.read().folders.every(row => !row.shared)).toBe(true)
    access.writePolicy()
    // The tools are told the choices are unavailable, so they pause every read (removed folders
    // included), and the next launch still sees them as unavailable rather than as a new account.
    expect(JSON.parse(readFileSync(policy, 'utf8'))).toMatchObject({ unavailable: true })
    expect(JSON.parse(readFileSync(policy, 'utf8')).blocked).toHaveLength(4)
    expect(access.read().folders.every(row => !row.shared)).toBe(true)
  })

  it('a lost record is rebuilt from the tools file, never reset to everything shared', async () => {
    const { access, items, policy } = setup({ pick: async () => '/Volumes/Work/Old Client' })

    await access.add()
    await access.remove('added:0')
    await access.apply({ documents: false })
    const enforced = readFileSync(policy, 'utf8')

    // The storage loses the key (reset, migration): this is not a new account.
    items.clear()

    expect(access.read().folders.map(row => [row.id, row.shared])).toEqual([
      ['desktop', true],
      ['documents', false],
      ['downloads', true],
      ['icloud', true]
    ])
    expect(access.closedFolders()).toEqual([`${HOME}/Documents`, '/Volumes/Work/Old Client'])
    access.writePolicy()
    expect(readFileSync(policy, 'utf8')).toBe(enforced)
  })

  it('a lost record with a damaged tools file pauses the tools, then the next choice recovers', async () => {
    const { access, policy } = setup()

    mkdirSync(path.dirname(policy), { recursive: true })
    writeFileSync(policy, '{"version":1,"blocked":["relative"]}')
    access.writePolicy()
    expect(JSON.parse(readFileSync(policy, 'utf8'))).toMatchObject({ unavailable: true })
    expect(access.sharedInsideClosedFolders()).toEqual([])

    await access.apply({ desktop: true })
    expect(JSON.parse(readFileSync(policy, 'utf8'))).toEqual({
      version: 1,
      blocked: [`${HOME}/Documents`, `${HOME}/Downloads`, `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`],
      shared: [`${HOME}/Desktop`]
    })
  })

  it('only an account with no record at all starts with everything shared', () => {
    const { access } = setup()

    access.writePolicy()
    expect(access.read().folders.every(row => row.shared)).toBe(true)
  })

  it('closes the folders the owner keeps closed for cloud commands on this Mac, iCloud apps included', async () => {
    const { access } = setup()

    expect(access.closedFolders()).toEqual([])
    await access.apply({ desktop: false, icloud: false })
    expect(access.closedFolders()).toEqual([
      `${HOME}/Desktop`,
      `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`,
      `${HOME}/Library/Mobile Documents`
    ])
    expect(setup({ scope: () => null }).access.closedFolders()).toEqual([])
  })

  it('lets cloud commands reach a folder the owner added inside a closed one', async () => {
    const { access } = setup({ pick: async () => `${HOME}/Desktop/Shared Work` })

    await access.apply({ desktop: false })
    await access.add()

    expect(access.closedFolders()).toEqual([`${HOME}/Desktop`])
    expect(access.sharedInsideClosedFolders()).toEqual([`${HOME}/Desktop/Shared Work`])
    expect(access.awareness().shared).toContain('~/Desktop/Shared Work')
  })

  it('hides iCloud Drive when it is not set up, and a folder that does not exist after asking', async () => {
    const { access, listed } = setup({
      answers: { Desktop: 'ENOENT' },
      exists: file => !file.endsWith('Mobile Documents')
    })

    expect(access.read().folders.map(row => row.id)).toEqual(['desktop', 'documents', 'downloads'])

    const view = await access.apply({ desktop: true, documents: true, downloads: true })

    expect(listed).not.toContain(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs`)
    expect(view.folders.map(row => row.id)).toEqual(['documents', 'downloads'])
  })

  it('keeps an unticked folder closed for the tools before any prompt answers', async () => {
    let release!: () => void

    const { access, policy } = setup({
      list: directory => directory.endsWith('Desktop') ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
    })

    const applying = access.apply({ desktop: true, documents: false })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    expect(JSON.parse(readFileSync(policy, 'utf8'))).toEqual({
      version: 1,
      blocked: [`${HOME}/Documents`],
      shared: [`${HOME}/Desktop`, `${HOME}/Downloads`, `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`]
    })

    release()
    await applying
  })

  it('adds a picked folder without a prompt, shows only its name, and removes it', async () => {
    const { access, listed, policy } = setup({ pick: async () => '/Volumes/Work/Clients' })

    const added = await access.add()
    const row = added.folders.at(-1)!

    expect(row).toEqual({ id: 'added:0', kind: 'added', name: 'Clients', shared: true, mac: 'granted' })
    expect(JSON.stringify(added)).not.toContain('/Volumes')
    expect(listed).toEqual([])
    expect(JSON.parse(readFileSync(policy, 'utf8')).shared).toContain('/Volumes/Work/Clients')
    expect(access.awareness().shared).toContain('/Volumes/Work/Clients')

    // Picking the same folder twice keeps one row; unticking it on Continue drops it.
    await access.add()
    expect(access.read().folders.filter(folder => folder.kind === 'added')).toHaveLength(1)
    await access.apply({ 'added:0': false })
    expect(access.read().folders.some(folder => folder.kind === 'added')).toBe(false)

    await access.add()
    expect((await access.remove('added:0')).folders.some(folder => folder.kind === 'added')).toBe(false)
  })

  it('removing or unticking an added folder closes it to the tools until it is picked again', async () => {
    const { access, policy } = setup({ pick: async () => '/Volumes/Work/Clients' })
    const tools = () => JSON.parse(readFileSync(policy, 'utf8')) as { blocked: string[]; shared: string[] }

    await access.add()
    await access.remove('added:0')
    expect(tools().blocked).toContain('/Volumes/Work/Clients')
    expect(tools().shared).not.toContain('/Volumes/Work/Clients')
    expect(access.closedFolders()).toContain('/Volumes/Work/Clients')

    await access.add()
    expect(tools().blocked).not.toContain('/Volumes/Work/Clients')
    expect(tools().shared).toContain('/Volumes/Work/Clients')

    await access.apply({ 'added:0': false })
    expect(tools().blocked).toContain('/Volumes/Work/Clients')
  })

  it('tells the assistant what it has in home-relative words', async () => {
    const { access } = setup()

    await access.apply({ desktop: true, documents: true, downloads: false, icloud: true })

    expect(access.awareness()).toEqual({
      shared: ['~/Desktop', '~/Documents', '~/Library/Mobile Documents/com~apple~CloudDocs'],
      skipped: ['~/Downloads']
    })
  })

  it('offers nothing off macOS or without an account, and refuses changes there', async () => {
    expect(setup({ platform: 'linux' }).access.read()).toEqual({ platform: 'unsupported', folders: [] })

    const signedOut = setup({ scope: () => null }).access

    expect(signedOut.read().folders).toEqual([])
    await expect(signedOut.apply({ desktop: true })).rejects.toThrow('matrix_folder_access_unavailable')
  })

  it('puts the tools file beside the source policy', () => {
    expect(folderAccessPolicyFile(`/x/source-policy/${ACCOUNT}.json`)).toBe(`/x/source-policy/${ACCOUNT}.folders.json`)
  })
})

describe('registerMatrixFolderAccessIpc', () => {
  function handlers() {
    const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    const access = {
      read: vi.fn(() => ({ platform: 'macos' as const, folders: [] })),
      apply: vi.fn(async () => ({ platform: 'macos' as const, folders: [] })),
      add: vi.fn(async () => ({ platform: 'macos' as const, folders: [] })),
      remove: vi.fn(async () => ({ platform: 'macos' as const, folders: [] }))
    }

    const assertTrusted = vi.fn()
    registerMatrixFolderAccessIpc({ handle: (channel, fn) => void registered.set(channel, fn as never) }, {
      assertTrusted,
      access
    })

    return { access, assertTrusted, call: (channel: string, ...args: unknown[]) => registered.get(channel)!({}, ...args) }
  }

  it('checks the caller and passes well-formed choices through', async () => {
    const { access, assertTrusted, call } = handlers()

    await call(MATRIX_FOLDER_ACCESS_IPC.apply, { desktop: false, 'added:3': true })

    expect(assertTrusted).toHaveBeenCalledOnce()
    expect(access.apply).toHaveBeenCalledWith({ desktop: false, 'added:3': true })
  })

  it.each([
    [MATRIX_FOLDER_ACCESS_IPC.apply, ['not-an-object']],
    [MATRIX_FOLDER_ACCESS_IPC.apply, [{ '/home/example/Desktop': true }]],
    [MATRIX_FOLDER_ACCESS_IPC.apply, [{ desktop: 'yes' }]],
    [MATRIX_FOLDER_ACCESS_IPC.remove, ['desktop']],
    [MATRIX_FOLDER_ACCESS_IPC.read, ['extra']]
  ])('refuses a malformed %s request', (channel, args) => {
    const { call } = handlers()

    expect(() => call(channel, ...args)).toThrow('matrix_folder_access_invalid_request')
  })
})
