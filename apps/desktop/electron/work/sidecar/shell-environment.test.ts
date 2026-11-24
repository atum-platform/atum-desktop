import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { workRuntimeEnvironment } from './process'
import { loginShellPath } from './shell-environment'

it('passes the login-shell PATH to Work while using the real HOME and account-scoped T3 state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'work-shell-'))
  const shell = join(home, 'fake-shell')

  try {
    await writeFile(
      shell,
      `#!/bin/sh
[ "$1" = -ilc ] || exit 1
PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/bin:/bin"
export PATH
/bin/sh -c "$2"
`,
      { mode: 0o700 }
    )
    const path = await loginShellPath({ HOME: home, SHELL: shell, PATH: '/usr/bin:/bin', SECRET: 'fixture' })
    const env = workRuntimeEnvironment('/account/work', '/resources', path)
    expect(env.PATH.split(':')).toContain(join(home, '.local/bin'))
    expect(env.PATH.split(':')).toContain(join(home, '.npm-global/bin'))
    expect(env.PATH.split(':')[0]).toBe('/resources/work-runtime')
    expect(env.HOME).toBe(homedir())
    expect(env.T3CODE_HOME).toBe('/account/work/server')
    expect(workRuntimeEnvironment('/other/work', '/resources').T3CODE_HOME).toBe('/other/work/server')
    expect(env).not.toHaveProperty('XDG_CONFIG_HOME', '/account/work/environment/config')
    expect(env).not.toHaveProperty('SECRET')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('shares one login shell capture for the app run', async () => {
  const first = loginShellPath()
  expect(loginShellPath()).toBe(first)
  await first
  expect(loginShellPath()).toBe(first)
})
