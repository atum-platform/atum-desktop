// GitSpawn (GHSA-7x36-8jrh-v4pw) regression tests for the desktop's own git
// calls. A real hostile repo is built in a temp dir; every automatic read the
// coding rail / review pane / worktree picker performs must leave no marker.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { fileDiffVsHead, repoStatus, reviewCommitContext, reviewDiff, reviewList } from './git-review-ops'
import {
  gitSubcommand,
  hardenedGitEnv,
  hardenGitArgv,
  isSafeGitRef,
  isUserGitOp,
  NO_DRIVER_DIFF_FLAGS,
  NO_SUBMODULE_RECURSION_FLAG,
  nonInteractiveGitEnv,
  repoFilterDriverOverrides,
  userGitEnv
} from './git-safe-env'
import { listBaseBranches, listBranches, listWorktrees } from './git-worktree-ops'

// `confighook` is a git-2.54 config-defined hook armed on post-index-change
// (status) and post-checkout (worktree add). core.hooksPath=/dev/null does not
// disable it; only the enumeration-and-blank in hardenedGitEnv does.
const SINKS = ['fsmonitor', 'hook', 'confighook', 'extdiff', 'textconv', 'clean', 'smudge', 'gpg', 'submoddiff']
const tempDirs: string[] = []

const cleanEnv: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull }

  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_') || key === 'GIT_CONFIG_COUNT') {
      delete env[key]
    }
  }

  return env
})()

const IDENT = ['-c', 'user.email=a@b', '-c', 'user.name=a', '-c', 'commit.gpgsign=false']

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, env: cleanEnv, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function gitLoose(cwd: string, args: string[]): void {
  try {
    git(cwd, args)
  } catch {
    // Baseline probes may exit non-zero (e.g. a dying external diff); only the
    // marker matters.
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function makeHostileRepo() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atum-gitspawn-')))

  tempDirs.push(tmp)
  const marker = path.join(tmp, 'MARKER')
  const touch = (sink: string) => `touch '${marker}.${sink}'`
  const repo = path.join(tmp, 'poc')

  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  fs.writeFileSync(path.join(repo, 'README'), 'hi\n')
  git(repo, [...IDENT, 'add', '.'])
  const tree = git(repo, ['write-tree']).trim()

  const body =
    `tree ${tree}\nauthor a <a@b> 1 +0000\ncommitter a <a@b> 1 +0000\n` +
    'gpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----\n\ninit\n'

  const sha = git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], body).trim()
  git(repo, ['update-ref', 'refs/heads/main', sha])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['reset', '-q', '--hard'])

  const hooks = path.join(repo, 'evil-hooks')
  fs.mkdirSync(hooks)

  for (const name of ['post-checkout', 'post-index-change']) {
    fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\n${touch('hook')}\n`, { mode: 0o755 })
  }

  const gpg = path.join(tmp, 'evil-gpg')
  fs.writeFileSync(gpg, `#!/bin/sh\n${touch('gpg')}\n`, { mode: 0o755 })

  fs.appendFileSync(
    path.join(repo, '.git', 'config'),
    `[core]\n\tfsmonitor = "${touch('fsmonitor')}"\n\thooksPath = ${hooks}\n` +
      `[diff "evil"]\n\tcommand = "${touch('extdiff')}"\n` +
      `\ttextconv = "sh -c \\"${touch('textconv')}; cat\\""\n` +
      `[filter "evil"]\n\tclean = "sh -c \\"${touch('clean')}; cat\\""\n` +
      `\tsmudge = "sh -c \\"${touch('smudge')}; cat\\""\n\trequired = true\n` +
      `[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${gpg}\n` +
      // git 2.54 config-defined hook: core.hooksPath does not turn this off.
      `[hook "chook"]\n\tevent = post-index-change\n\tevent = post-checkout\n\tcommand = ${touch('confighook')}\n`
  )
  fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* diff=evil filter=evil\n')

  // Same-size edit with a new mtime: status must re-hash → clean filter runs.
  const readme = path.join(repo, 'README')
  const st = fs.statSync(readme)
  fs.writeFileSync(readme, 'ho\n')
  fs.utimesSync(readme, st.atime, new Date(st.mtimeMs + 10_000))

  return { repo, marker }
}

function fired(marker: string): string[] {
  const out: string[] = []

  for (const sink of SINKS) {
    const file = `${marker}.${sink}`

    if (fs.existsSync(file)) {
      out.push(sink)
      fs.rmSync(file)
    }
  }

  return out
}

test('hardenGitArgv adds driver flags to diff renderers and the submodule guard to status/diff', () => {
  assert.deepEqual(hardenGitArgv(['diff', 'HEAD']), [
    'diff',
    ...NO_DRIVER_DIFF_FLAGS,
    NO_SUBMODULE_RECURSION_FLAG,
    'HEAD'
  ])
  assert.deepEqual(hardenGitArgv(['log', '-n', '1']), ['log', ...NO_DRIVER_DIFF_FLAGS, '-n', '1'])
  assert.deepEqual(hardenGitArgv(['status', '--porcelain']), ['status', NO_SUBMODULE_RECURSION_FLAG, '--porcelain'])
  assert.deepEqual(hardenGitArgv(['rev-parse', 'HEAD']), ['rev-parse', 'HEAD'])
  assert.deepEqual(hardenGitArgv(['-C', 'diff', 'rev-parse']), ['-C', 'diff', 'rev-parse'])
  assert.equal(gitSubcommand(['-c', 'user.name=a', 'commit']), 'commit')
})

test('user ops keep the user config; automatic reads do not', () => {
  assert.equal(isUserGitOp(['commit', '-m', 'x']), true)
  assert.equal(isUserGitOp(['worktree', 'add', 'x']), true)
  assert.equal(isUserGitOp(['worktree', 'list', '--porcelain']), false)
  assert.equal(isUserGitOp(['status']), false)
  assert.equal(nonInteractiveGitEnv({}).GIT_CONFIG_GLOBAL, os.devNull)
  assert.equal(userGitEnv({}).GIT_CONFIG_GLOBAL, undefined)
})

test('baseline: the fixture is armed (unhardened git fires the sinks)', () => {
  const { repo, marker } = makeHostileRepo()

  let configHooksSupported = false

  try {
    const hooks = git(repo, ['hook', 'list', 'post-index-change'])

    assert.match(hooks, /chook/)
    configHooksSupported = true
  } catch (cause) {
    // Older supported macOS Git has only `hook run`. Keep every other sink
    // armed, and require config-hook execution when Git exposes that feature.
    assert.match(String((cause as { stderr?: string }).stderr), /unknown subcommand: [`']list/)
  }

  fired(marker)
  gitLoose(repo, ['status', '--porcelain'])
  const afterStatus = fired(marker)
  // `confighook` (post-index-change) fires on status despite core.hooksPath.
  assert.ok(
    ['fsmonitor', 'clean', ...(configHooksSupported ? ['confighook'] : [])].every(s => afterStatus.includes(s)),
    afterStatus.join(',')
  )
  gitLoose(repo, ['diff', 'HEAD'])
  const afterDiff = fired(marker)
  assert.ok(afterDiff.includes('extdiff'), afterDiff.join(','))
  gitLoose(repo, ['log', '-1', '--pretty=%h'])
  assert.ok(fired(marker).includes('gpg'))
})

test('filter-driver and config-hook enumeration lists the repo-defined driver and hook', async () => {
  const { repo } = makeHostileRepo()
  const overrides = await repoFilterDriverOverrides('git', repo)

  assert.equal(overrides['filter.evil.clean'], '')
  assert.equal(overrides['filter.evil.required'], 'false')
  assert.equal(overrides['hook.chook.enabled'], 'false')
  assert.equal(overrides['hook.chook.event'], '')
})

test('hardenedGitEnv blanks the config hook for every subcommand, not just content ones', async () => {
  const { repo } = makeHostileRepo()

  for (const sub of [['rev-parse', 'HEAD'], ['log', '-1'], ['status']]) {
    const env = await hardenedGitEnv('git', repo, sub)
    const block: Record<string, string> = {}
    const count = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0

    for (let i = 0; i < count; i++) {
      block[String(env[`GIT_CONFIG_KEY_${i}`])] = String(env[`GIT_CONFIG_VALUE_${i}`])
    }

    assert.equal(block['hook.chook.enabled'], 'false', sub.join(' '))
    assert.equal(block['hook.chook.event'], '', sub.join(' '))
  }
})

test('config hook on worktree add (post-checkout) is inert under the hardened env', async () => {
  const { repo, marker } = makeHostileRepo()

  fired(marker)

  const wt = path.join(path.dirname(repo), 'hook-wt')
  const argv = hardenGitArgv(['-C', repo, 'worktree', 'add', wt, '-b', 'hook-safe', 'HEAD'])
  const env = await hardenedGitEnv('git', repo, argv)

  execFileSync('git', argv, { env: env as NodeJS.ProcessEnv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  assert.ok(fs.existsSync(path.join(wt, 'README')), 'worktree still checks out')
  assert.deepEqual(fired(marker), [])
})

test('isSafeGitRef rejects option-like and range values', () => {
  assert.equal(isSafeGitRef('a1b2c3d4e5f6'), true)
  assert.equal(isSafeGitRef('origin/main'), true)
  assert.equal(isSafeGitRef('HEAD~3'), true)
  assert.equal(isSafeGitRef(''), false)
  assert.equal(isSafeGitRef(null), false)
  assert.equal(isSafeGitRef(undefined), false)
  assert.equal(isSafeGitRef('--output=/tmp/pwn'), false)
  assert.equal(isSafeGitRef('-O/tmp/pwn'), false)
  assert.equal(isSafeGitRef('HEAD~5..HEAD'), false)
  assert.equal(isSafeGitRef('a b'), false)
  assert.equal(isSafeGitRef('--ext-diff'), false)
})

test('reviewList / reviewDiff refuse an option-like baseRef (lastTurn scope)', async () => {
  const { repo, marker } = makeHostileRepo()

  fired(marker)

  const list = await reviewList(repo, 'lastTurn', '--output=/tmp/pwn', 'git')
  assert.deepEqual(list, { files: [], base: null })

  const diff = await reviewDiff(repo, 'README', 'lastTurn', '-O/tmp/pwn', false, 'git')
  assert.equal(diff, '')
  assert.deepEqual(fired(marker), [])
})

test('coding rail, review pane and worktree picker reads execute nothing from the repo config', async () => {
  const { repo, marker } = makeHostileRepo()

  fired(marker)

  const status = await repoStatus(repo, 'git')
  assert.ok(status, 'repoStatus still works under the hardened env')
  assert.equal(status.branch, 'main')

  await reviewList(repo, 'uncommitted', null, 'git')
  await reviewDiff(repo, 'README', 'uncommitted', null, false, 'git')
  await fileDiffVsHead(repo, 'README', 'git')
  await reviewCommitContext(repo, 'git')
  await listWorktrees(repo, 'git')
  await listBranches(repo, 'git')
  await listBaseBranches(repo, 'git')

  assert.deepEqual(fired(marker), [])
})

// A super-repo with diff.submodule=diff whose submodule gitlink points at an
// older commit than its checkout, so `git log -p` recurses a child `git diff`
// inside the submodule under the submodule's own (hostile) config. The inert
// override block pins diff.submodule=short to stop that recursion.
function makeSubmoduleDiffRepo() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atum-gitspawn-sm-')))

  tempDirs.push(tmp)
  const marker = path.join(tmp, 'MARKER')
  const sub = path.join(tmp, 'sub')

  fs.mkdirSync(sub)
  git(sub, ['init', '-q'])
  fs.writeFileSync(path.join(sub, 'f'), 's1\n')
  git(sub, [...IDENT, 'add', 'f'])
  git(sub, [...IDENT, 'commit', '-qm', 's1'])
  const first = git(sub, ['rev-list', '--max-parents=0', 'HEAD']).trim()
  fs.writeFileSync(path.join(sub, 'f'), 's2\n')
  git(sub, [...IDENT, 'add', 'f'])
  git(sub, [...IDENT, 'commit', '-qm', 's2'])

  const repo = path.join(tmp, 'super')

  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['-c', 'protocol.file.allow=always', ...IDENT, 'submodule', '--quiet', 'add', sub, 'sm'])
  git(repo, [...IDENT, 'commit', '-qm', 'add sm'])
  git(repo, ['update-index', '--cacheinfo', '160000', first, 'sm'])

  const subGit = path.join(repo, '.git', 'modules', 'sm')
  const touch = (sink: string) => `touch '${marker}.${sink}'`

  fs.appendFileSync(path.join(subGit, 'config'), `[diff "ev"]\n\tcommand = ${touch('submoddiff')}\n`)
  fs.mkdirSync(path.join(subGit, 'info'), { recursive: true })
  fs.writeFileSync(path.join(subGit, 'info', 'attributes'), '* diff=ev\n')
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[diff]\n\tsubmodule = diff\n')

  return { repo, marker }
}

test('baseline: diff.submodule=diff fires the submodule-local diff driver on log -p', () => {
  const { repo, marker } = makeSubmoduleDiffRepo()

  fired(marker)
  gitLoose(repo, ['-c', 'diff.submodule=diff', 'log', '-1', '-p', '--ignore-submodules=dirty'])
  assert.ok(fired(marker).includes('submoddiff'))
})

test('submodule inline diff is inert under the hardened env (diff.submodule=short)', async () => {
  const { repo, marker } = makeSubmoduleDiffRepo()

  fired(marker)

  const argv = hardenGitArgv(['-C', repo, 'log', '-1', '-p'])
  const env = await hardenedGitEnv('git', repo, argv)

  try {
    execFileSync('git', argv, { env: env as NodeJS.ProcessEnv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    // log exit code is irrelevant; only the marker matters.
  }

  assert.deepEqual(fired(marker), [])
})
