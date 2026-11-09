import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  ATUM_APPROVALS_DEFAULT_BLOCK,
  type AtumApprovalDefaultDeps,
  ensureAtumAgentApprovalDefault,
  ensureAtumApprovalDefault,
  hasApprovalsBlock,
  isAtumManagedAgent,
  shouldApplyAtumApprovalDefault
} from './atum-approval-default'

function memoryDeps(files: Record<string, string> = {}) {
  const writes: Array<[string, string]> = []
  const dirs: string[] = []

  const deps: AtumApprovalDefaultDeps = {
    exists: target => target in files,
    readFile: target => files[target]!,
    writeFile: (target, contents) => {
      files[target] = contents
      writes.push([target, contents])
    },
    mkdirp: target => dirs.push(target)
  }

  return { deps, dirs, files, writes }
}

test('a fresh home gets a config whose only content is the quoted off default', () => {
  const { deps, dirs, files } = memoryDeps()

  assert.equal(ensureAtumApprovalDefault('/home/config.yaml', deps), 'created')
  assert.deepEqual(dirs, ['/home'])
  assert.match(files['/home/config.yaml']!, /^approvals:\n {2}mode: "off"\n$/mu)
  // Never a bare `off`: YAML 1.1 would read it as boolean false and Hermes
  // would treat that as manual mode.
  assert.doesNotMatch(files['/home/config.yaml']!, /mode: off\b/u)
})

test('a config without an approvals block gets the block appended once, keeping everything else byte-for-byte', () => {
  const original = '_config_version: 33\nmodel:\n  default: binh-minh\n'
  const { deps, files, writes } = memoryDeps({ '/home/config.yaml': original })

  assert.equal(ensureAtumApprovalDefault('/home/config.yaml', deps), 'appended')
  assert.equal(files['/home/config.yaml'], `${original}${ATUM_APPROVALS_DEFAULT_BLOCK}`)
  assert.equal(writes.length, 1)

  // Second boot: the block is there, nothing is written.
  assert.equal(ensureAtumApprovalDefault('/home/config.yaml', deps), 'kept')
  assert.equal(writes.length, 1)
})

test('a config the user already owns is never touched, whatever the mode says', () => {
  for (const block of ['approvals:\n  mode: manual\n', 'approvals:\n  mode: smart\n', 'approvals: {}\n', 'approvals:\n  timeout: 60\n']) {
    const original = `_config_version: 33\n${block}`
    const { deps, files, writes } = memoryDeps({ '/home/config.yaml': original })

    assert.equal(ensureAtumApprovalDefault('/home/config.yaml', deps), 'kept')
    assert.equal(files['/home/config.yaml'], original)
    assert.equal(writes.length, 0)
  }
})

test('quoted and merged approval keys preserve the user choice', () => {
  for (const original of [
    '"approvals":\n  mode: manual\n',
    "'approvals': {mode: smart}\n",
    'defaults: &defaults\n  approvals: {mode: manual}\n<<: *defaults\n'
  ]) {
    const { deps, files, writes } = memoryDeps({ '/home/config.yaml': original })

    assert.equal(ensureAtumApprovalDefault('/home/config.yaml', deps), 'kept')
    assert.equal(files['/home/config.yaml'], original)
    assert.equal(writes.length, 0)
  }
})

test('malformed, duplicate-key or non-mapping configs are left untouched', () => {
  for (const original of [
    'broken: [\n', 'approvals: {}\napprovals: {mode: manual}\n',
    '- item\n', 'text\n', 'model: first\n---\nmodel: second\n',
    'null\n', '~\n', 'NULL\n', '---\n'
  ]) {
    const { deps, files, writes } = memoryDeps({ '/home/config.yaml': original })

    assert.equal(ensureAtumApprovalDefault('/home/config.yaml', deps), 'kept')
    assert.equal(files['/home/config.yaml'], original)
    assert.equal(writes.length, 0)
  }
})

test('an indented or commented approvals key does not count as the block', () => {
  assert.equal(hasApprovalsBlock(''), false)
  assert.equal(hasApprovalsBlock('tools:\n  approvals: 1\n'), false)
  assert.equal(hasApprovalsBlock('# approvals:\n#   mode: off\n'), false)
  assert.equal(hasApprovalsBlock('approvals:\n  mode: "off"\n'), true)
  assert.equal(hasApprovalsBlock('x: 1\napprovals :\n'), true)
})

test('a file without a trailing newline still gets a well-formed block', () => {
  const { deps, files } = memoryDeps({ '/home/config.yaml': 'model:\n  default: x' })

  ensureAtumApprovalDefault('/home/config.yaml', deps)
  assert.match(files['/home/config.yaml']!, /default: x\n\n# Atum acts/u)
})

test('the default applies only to the desktop-owned home, never an explicit HERMES_HOME', () => {
  assert.equal(shouldApplyAtumApprovalDefault({}), true)
  assert.equal(shouldApplyAtumApprovalDefault({ HERMES_HOME: '' }), true)
  assert.equal(shouldApplyAtumApprovalDefault({ HERMES_HOME: '/home/example/.hermes' }), false)
})

test('an agent Atum created gets Atum\'s approval posture before its backend starts', () => {
  const { deps, files } = memoryDeps({ '/home/profiles/mkt/profile.yaml': 'display_name: Marketing\nmanaged_by: atum\n' })

  assert.equal(ensureAtumAgentApprovalDefault('/home/profiles/mkt', deps), 'created')
  assert.match(files['/home/profiles/mkt/config.yaml']!, /mode: "off"/u)

  // Idempotent, so the same call at every spawn is a repair, not a rewrite.
  assert.equal(ensureAtumAgentApprovalDefault('/home/profiles/mkt', deps), 'kept')
})

test('a profile made with the CLI is never touched, whatever it looks like', () => {
  for (const metadata of [
    'display_name: Hand made\n',
    'managed_by: ""\n',
    'managed_by: someone-else\n',
    '# managed_by: atum\n'
  ]) {
    const { deps, files, writes } = memoryDeps({ '/home/profiles/hand/profile.yaml': metadata })

    assert.equal(isAtumManagedAgent('/home/profiles/hand', deps), false, metadata)
    assert.equal(ensureAtumAgentApprovalDefault('/home/profiles/hand', deps), 'not-managed')
    assert.equal(writes.length, 0)
    assert.equal('/home/profiles/hand/config.yaml' in files, false)
  }
})

test('a profile with no metadata at all is left alone', () => {
  const { deps, writes } = memoryDeps()

  assert.equal(isAtumManagedAgent('/home/profiles/bare', deps), false)
  assert.equal(ensureAtumAgentApprovalDefault('/home/profiles/bare', deps), 'not-managed')
  assert.equal(writes.length, 0)
})

test('malformed or contradictory YAML never authorizes automatic approval repair', () => {
  for (const metadata of [
    'managed_by: atum\nmanaged_by: human\n',
    'managed_by: human\nmanaged_by: atum\n',
    'managed_by: atum\nbroken: [\n',
    'managed_by: "atum\n',
    "managed_by: 'atum\"\n",
    '- managed_by: atum\n',
    'nested:\n  managed_by: atum\n',
    'managed_by: atum\n---\nmanaged_by: human\n'
  ]) {
    const { deps, writes } = memoryDeps({ '/home/profiles/hand/profile.yaml': metadata })

    assert.equal(isAtumManagedAgent('/home/profiles/hand', deps), false, metadata)
    assert.equal(ensureAtumAgentApprovalDefault('/home/profiles/hand', deps), 'not-managed')
    assert.equal(writes.length, 0)
  }
})

test('an agent whose owner already chose a posture keeps it', () => {
  const { deps, files, writes } = memoryDeps({
    '/home/profiles/mkt/profile.yaml': 'managed_by: atum\n',
    '/home/profiles/mkt/config.yaml': 'approvals:\n  mode: manual\n'
  })

  assert.equal(ensureAtumAgentApprovalDefault('/home/profiles/mkt', deps), 'kept')
  assert.equal(files['/home/profiles/mkt/config.yaml'], 'approvals:\n  mode: manual\n')
  assert.equal(writes.length, 0)
})

test('valid quoted, indented or flow-mapping ownership is parsed consistently', () => {
  for (const metadata of [
    'managed_by: "atum"\n', "managed_by: 'atum'\n", 'managed_by:   atum  \n',
    '  managed_by: atum\n', '{managed_by: atum}\n', 'managed_by: atum # owner\n'
  ]) {
    const { deps } = memoryDeps({ '/home/profiles/mkt/profile.yaml': metadata })

    assert.equal(isAtumManagedAgent('/home/profiles/mkt', deps), true, metadata)
  }
})
