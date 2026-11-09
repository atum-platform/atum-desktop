import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

import { test } from 'vitest'

const DESKTOP_ROOT = resolve(import.meta.dirname, '../..')

const S5_ENGINE_FILES = [
  'electron/atum-messaging/direct-transport.ts',
  'electron/atum-messaging/group-store.ts',
  'electron/atum-messaging/migrations.ts',
  'electron/atum-messaging/social.ts',
  'electron/atum-messaging/store.ts',
  'electron/atum-messaging/sync-engine.ts',
  'electron/atum-messaging/transport-error.ts',
  'electron/atum-messaging/types.ts',
  'src/lib/atum-direct-messaging-client.ts',
  'src/store/atum-messaging.ts'
] as const

const NON_ENGINE_PRODUCTION_FILES = new Set([
  'account-auth.ts',
  'account-ipc.ts',
  'account-roots.ts',
  'advisory-history-source.ts',
  'app-surfaces-ipc.ts',
  'app-surfaces.ts',
  'auth-deep-link.ts',
  'credential-vault.ts',
  'group-wire.ts',
  'http-client.ts',
  'index.ts',
  'ipc.ts',
  'private-advisory-runner.ts',
  'shared-group-control.ts',
  'shared-group-device.ts',
  'shared-group-runner.ts',
  'public-config.ts',
  'runtime.ts',
  'sync-coordinator.ts',
  'window-events.ts',
  'wire.ts',
  'workspace-home.ts'
])

const FORBIDDEN_ENGINE_IMPORT =
  /(?:app-surfaces|specialist|artifact|atum-account-client|account-auth|account-ipc|auth-deep-link|credential-vault|atum-dm-workspace|workbench-tabs)/u

function importSpecifiers(source: string): string[] {
  const staticImports = [
    ...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu)
  ]

  const dynamicImports = [...source.matchAll(/(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/gu)]

  return [...staticImports, ...dynamicImports].map(match => match[1]!)
}

function resolveTypeScriptImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }

  const unresolved = resolve(dirname(fromFile), specifier)
  const candidates = [unresolved, `${unresolved}.ts`, resolve(unresolved, 'index.ts')]

  return candidates.find(candidate => existsSync(candidate)) ?? null
}

test('every messaging production module is explicitly classified as engine or composition/custody', () => {
  const productionFiles = readdirSync(resolve(DESKTOP_ROOT, 'electron/atum-messaging'))
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .sort()

  const engineFiles = new Set(S5_ENGINE_FILES.map(file => file.replace('electron/atum-messaging/', '')))
  const unclassified = productionFiles.filter(file => !engineFiles.has(file) && !NON_ENGINE_PRODUCTION_FILES.has(file))

  assert.deepEqual(unclassified, [])
})

test('every messaging production module is reachable from the shipping Electron entry points', () => {
  const messagingRoot = resolve(DESKTOP_ROOT, 'electron/atum-messaging')

  const productionFiles = readdirSync(messagingRoot)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map(file => resolve(messagingRoot, file))
    .sort()

  const productionSet = new Set(productionFiles)
  const mainFile = resolve(DESKTOP_ROOT, 'electron/main.ts')
  const queue = [resolve(messagingRoot, 'index.ts')]

  for (const specifier of importSpecifiers(readFileSync(mainFile, 'utf8'))) {
    const target = resolveTypeScriptImport(mainFile, specifier)

    if (target && productionSet.has(target)) {
      queue.push(target)
    }
  }

  const reachable = new Set<string>()

  while (queue.length > 0) {
    const current = queue.pop()!

    if (reachable.has(current) || !productionSet.has(current)) {
      continue
    }

    reachable.add(current)

    for (const specifier of importSpecifiers(readFileSync(current, 'utf8'))) {
      const target = resolveTypeScriptImport(current, specifier)

      if (target && productionSet.has(target) && !reachable.has(target)) {
        queue.push(target)
      }
    }
  }

  assert.deepEqual(
    productionFiles.filter(file => !reachable.has(file)).map(file => relative(messagingRoot, file)),
    []
  )
})

test('S5 engine imports cannot reach S2 auth, S6 app/artifact, or S4 DM workspace ownership', () => {
  const violations = S5_ENGINE_FILES.flatMap(file => {
    const imports = importSpecifiers(readFileSync(resolve(DESKTOP_ROOT, file), 'utf8'))

    return imports
      .filter(specifier => FORBIDDEN_ENGINE_IMPORT.test(specifier))
      .map(specifier => `${file} -> ${specifier}`)
  })

  assert.deepEqual(violations, [])
})

test('the direct renderer client exposes no specialist, app-link, or artifact operations', () => {
  const source = readFileSync(resolve(DESKTOP_ROOT, 'src/lib/atum-direct-messaging-client.ts'), 'utf8')
  const pick = /Pick<\s*AtumMessagingClient,([\s\S]*?)\n>/u.exec(source)?.[1]

  assert.ok(pick, 'direct client Pick<> boundary must remain explicit')
  assert.doesNotMatch(pick, /artifact|specialist|linkedApps|disconnectApp/u)
})

test('cross-stream renderer wiring remains isolated to one visible composition point', () => {
  const source = readFileSync(resolve(DESKTOP_ROOT, 'src/app/atum/messaging-composition.ts'), 'utf8')
  const imports = importSpecifiers(source)

  assert.ok(imports.some(specifier => specifier.includes('atum-account-client')))
  assert.ok(imports.some(specifier => specifier.includes('atum-dm-workspace')))
  assert.ok(source.includes('ensureSpecialistConversation'))
})
