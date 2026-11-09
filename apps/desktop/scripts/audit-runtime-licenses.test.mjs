import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import {
  REQUIRED_RUNTIME_COMPONENTS,
  RESTRICTED_STAGED_SKILL_PATHS,
  assertRuntimeLicensePolicy,
  assertRuntimeLicenseReleaseReadiness,
  auditRuntimeLicenses,
  verifyRuntimeLicenseManifest
} from './audit-runtime-licenses.mjs'
import BROWSER_RUNTIME from '../browser-runtime.json' with { type: 'json' }
import { readFile } from 'node:fs/promises'

const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atum-runtime-license-audit-'))
  directories.push(root)
  const runtime = path.join(root, 'runtime')
  for (const component of REQUIRED_RUNTIME_COMPONENTS) {
    for (const license of component.licenses) {
      const target = path.join(runtime, license)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, `license:${license}\n`, 'utf8')
    }
  }
  await mkdir(path.join(runtime, 'browser/bin'), { recursive: true })
  await mkdir(path.join(runtime, 'browser/chromium'), { recursive: true })
  await writeFile(path.join(runtime, 'browser/bin/agent-browser'), '#!/bin/sh\n', 'utf8')
  await writeFile(
    path.join(runtime, 'browser/chromium', BROWSER_RUNTIME.chromium.root, 'LICENSE.headless_shell'),
    'chromium license\n',
    'utf8'
  )
  await writeFile(path.join(runtime, 'hermes-agent/runtime.py'), 'print("runtime")\n', 'utf8')
  return { root, runtime }
}

it('emits a deterministic inventory of the required redistributable runtime components', async () => {
  const { runtime } = await fixture()
  const first = await auditRuntimeLicenses({ runtimeRoot: runtime })
  const second = await auditRuntimeLicenses({ runtimeRoot: runtime })

  expect(second).toEqual(first)
  expect(first.policy).toEqual({ outcome: 'pass', issueCount: 0 })
  expect(first.components.map(component => component.id)).not.toContain('productivity-docx')
  expect(first.components.map(component => component.id)).toContain('agent-browser')
  expect(first.discoveredLicenses.map(license => license.path)).toContain('browser/licenses/agent-browser-LICENSE')
  expect(first.components.find(component => component.id === 'chromium-runtime').licenses[0].path).toBe(
    `browser/chromium/${BROWSER_RUNTIME.chromium.root}/LICENSE.headless_shell`
  )
  expect(first.discoveredLicenses.map(license => license.path)).not.toContain('hermes-agent/skills/productivity/powerpoint/LICENSE.txt')
  expect(() => assertRuntimeLicensePolicy(first)).not.toThrow()
})

it('fails policy when a prohibited proprietary productivity skill is packaged', async () => {
  const { runtime } = await fixture()
  for (const restrictedPath of RESTRICTED_STAGED_SKILL_PATHS) {
    await mkdir(path.join(runtime, restrictedPath), { recursive: true })
    await writeFile(path.join(runtime, restrictedPath, 'LICENSE.txt'), 'restricted\n', 'utf8')
  }

  const manifest = await auditRuntimeLicenses({ runtimeRoot: runtime })

  expect(manifest.issues).toHaveLength(RESTRICTED_STAGED_SKILL_PATHS.length)
  for (const path of RESTRICTED_STAGED_SKILL_PATHS) {
    expect(manifest.issues).toContainEqual({ code: 'packaged_restricted_skill', path })
  }
  expect(() => assertRuntimeLicensePolicy(manifest)).toThrow(
    'runtime_license_policy_failed:packaged_restricted_skill:hermes-agent/skills/productivity/docx'
  )
})

it('detects a stale manifest when a staged license changes', async () => {
  const { runtime } = await fixture()
  const manifest = await auditRuntimeLicenses({ runtimeRoot: runtime })
  await writeFile(path.join(runtime, 'browser/node/LICENSE'), 'changed\n', 'utf8')

  await expect(verifyRuntimeLicenseManifest({ runtimeRoot: runtime, manifest })).rejects.toThrow('runtime_license_inventory_invalid:stale_manifest')
})

it('fails policy for missing required third-party license evidence', async () => {
  const { runtime } = await fixture()
  await rm(path.join(runtime, 'browser/licenses/agent-browser-LICENSE'))
  const manifest = await auditRuntimeLicenses({ runtimeRoot: runtime })

  expect(manifest.issues).toContainEqual({ code: 'required_license_missing', component: 'agent-browser', path: 'browser/licenses/agent-browser-LICENSE' })
  expect(() => assertRuntimeLicensePolicy(manifest)).toThrow('runtime_license_policy_failed:required_license_missing:browser/licenses/agent-browser-LICENSE')
})

it('fails policy when the actual staged Chromium license is absent', async () => {
  const { runtime } = await fixture()
  const chromium = REQUIRED_RUNTIME_COMPONENTS.find(component => component.id === 'chromium-runtime')
  await rm(path.join(runtime, chromium.licenses[0]))
  const manifest = await auditRuntimeLicenses({ runtimeRoot: runtime })

  expect(manifest.issues).toContainEqual({
    code: 'required_license_missing',
    component: 'chromium-runtime',
    path: chromium.licenses[0]
  })
})

it('fails policy when the required Hermes core license is absent', async () => {
  const { runtime } = await fixture()
  await rm(path.join(runtime, 'hermes-agent/LICENSE'))
  const manifest = await auditRuntimeLicenses({ runtimeRoot: runtime })

  expect(manifest.issues).toContainEqual({
    code: 'required_license_missing',
    component: 'hermes-core',
    path: 'hermes-agent/LICENSE'
  })
  expect(() => assertRuntimeLicensePolicy(manifest)).toThrow(
    'runtime_license_policy_failed:required_license_missing:hermes-agent/LICENSE'
  )
})

it('records an unclassified third-party license without inferring its terms or claiming legal clearance', async () => {
  const { runtime } = await fixture()
  const thirdParty = path.join(runtime, 'hermes-agent/vendor/example/LICENSE')
  await mkdir(path.dirname(thirdParty), { recursive: true })
  await writeFile(thirdParty, 'unknown terms\n', 'utf8')
  const manifest = await auditRuntimeLicenses({ runtimeRoot: runtime })

  expect(manifest.issues).toEqual([])
  expect(manifest.advisories).toContainEqual({ code: 'unclassified_license_inventory', path: 'hermes-agent/vendor/example/LICENSE' })
  expect(() => assertRuntimeLicensePolicy(manifest)).not.toThrow()
  expect(() => assertRuntimeLicenseReleaseReadiness({ ...manifest, advisories: [{ code: 'unclassified_license_inventory', path: 'hermes-agent/vendor/example/LICENSE' }] })).toThrow('runtime_license_policy_failed:unclassified_license_inventory:hermes-agent/vendor/example/LICENSE')
})

it('keeps uniquely attributed installed Python licence evidence release-blocking', async () => {
  const { runtime } = await fixture()
  const site = 'python/lib/python3.14/site-packages'
  const dist = `${site}/example-1.0.dist-info`
  const license = `${dist}/licenses/LICENSE`
  await mkdir(path.join(runtime, dist, 'licenses'), { recursive: true })
  await writeFile(path.join(runtime, license), 'Example redistribution licence\n')
  await writeFile(path.join(runtime, dist, 'RECORD'), 'example-1.0.dist-info/licenses/LICENSE,,\nexample-1.0.dist-info/METADATA,,\n')
  await writeFile(path.join(runtime, dist, 'METADATA'), 'Metadata-Version: 2.4\nName: example\nVersion: 1.0\nLicense-Expression: MIT\nLicense-File: licenses/LICENSE\n\n')

  const manifest = await auditRuntimeLicenses({ runtimeRoot: runtime })
  expect(manifest.licenseAttributions).toContainEqual(expect.objectContaining({
    path: license,
    disposition: 'legal_review_required',
    attribution: expect.objectContaining({ status: 'attributed' })
  }))
  // A component shipped on a licence that needs the owner's sign-off would stay an advisory too.
  const componentReviews = REQUIRED_RUNTIME_COMPONENTS.filter(
    component => component.disposition === 'legal_review_required'
  ).map(component => ({ code: 'legal_review_required', component: component.id, paths: [...component.licenses].sort() }))
  expect(manifest.advisories).toEqual(
    expect.arrayContaining([{ code: 'legal_review_required', path: license }, ...componentReviews])
  )
  expect(manifest.advisories).toHaveLength(1 + componentReviews.length)
  expect(manifest.legalReview).toEqual({ outcome: 'review_required', advisoryCount: 1 + componentReviews.length })
  expect(() => assertRuntimeLicensePolicy(manifest)).not.toThrow()
  expect(() => assertRuntimeLicenseReleaseReadiness(manifest)).toThrow('runtime_license_policy_failed:legal_review_required:')
})

it('excludes source named after a notice while retaining an actual licence and configured evidence', async () => {
  const { runtime } = await fixture()
  const directory = path.join(runtime, 'hermes-agent', 'src')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'notice-band.test.tsx'), 'export const notice = true\n')
  await writeFile(path.join(directory, 'NOTICE.txt'), 'Redistribution notice\n')
  const manifest = await auditRuntimeLicenses({ runtimeRoot: runtime })
  expect(manifest.discoveredLicenses.map(file => file.path)).toContain('hermes-agent/src/NOTICE.txt')
  expect(manifest.discoveredLicenses.map(file => file.path)).not.toContain('hermes-agent/src/notice-band.test.tsx')
  expect(manifest.discoveredLicenses.map(file => file.path)).toContain('browser/licenses/agent-browser-LICENSE')
  expect(manifest.advisories).toContainEqual({ code: 'unclassified_license_inventory', path: 'hermes-agent/src/NOTICE.txt' })
  expect(() => assertRuntimeLicenseReleaseReadiness(manifest)).toThrow('runtime_license_policy_failed:')
})

it('allows a symlink only when its resolved target remains inside the staged runtime', async () => {
  const { runtime } = await fixture()
  const license = path.join(runtime, 'browser/node/LICENSE')
  await rm(license)
  await symlink(`../chromium/${BROWSER_RUNTIME.chromium.root}/LICENSE.headless_shell`, license)
  const manifest = await auditRuntimeLicenses({ runtimeRoot: runtime })

  expect(manifest.components.find(component => component.id === 'node-runtime').licenses[0].symlink).toBe(
    `browser/chromium/${BROWSER_RUNTIME.chromium.root}/LICENSE.headless_shell`
  )
})

it('rejects a symlink that resolves outside the staged runtime', async () => {
  const { root, runtime } = await fixture()
  const license = path.join(runtime, 'browser/node/LICENSE')
  await rm(license)
  const outside = path.join(root, 'outside')
  await writeFile(outside, 'outside\n', 'utf8')
  await symlink(outside, license)

  await expect(auditRuntimeLicenses({ runtimeRoot: runtime })).rejects.toThrow('runtime_license_inventory_invalid:symlink_escapes_root:browser/node/LICENSE')
})
