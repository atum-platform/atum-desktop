import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { attributeRuntimeLicenses } from './runtime-license-attribution.mjs'

const directories = []
const sitePackages = 'python/lib/python3.14/site-packages'
const digest = value => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atum-runtime-license-attribution-'))
  directories.push(root)
  const runtime = path.join(root, 'runtime')
  const written = new Map()
  const write = async (relative, value) => {
    const target = path.join(runtime, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, value, 'utf8')
    written.set(relative, value)
  }
  const inventory = () => [...written].map(([filePath, value]) => ({ path: filePath, bytes: Buffer.byteLength(value), sha256: digest(value) }))
  return { runtime, write, inventory }
}

it('attributes a Python license artifact by exact RECORD ownership while retaining legal review', async () => {
  const { runtime, write, inventory } = await fixture()
  const dist = `${sitePackages}/example_pkg-1.2.3.dist-info`
  const license = `${dist}/licenses/LICENSE, "third-party".txt`
  await write(license, 'license evidence')
  await write('python/bin/example', '#!/bin/sh\n')
  await write(`${dist}/METADATA`, 'Name: Example Package\nVersion: 1.2.3\nLicense-Expression: MIT\nLicense-File: LICENSE.txt\n\nignored body')
  await write(`${dist}/LICENSE.txt`, 'license text')

  // RFC CSV quoting is required for a filename with a comma.
  await write(`${dist}/RECORD`, '"example_pkg-1.2.3.dist-info/licenses/LICENSE, ""third-party"".txt",sha256=not-a-real-digest,17\n../../../bin/example,,\n')
  await write('browser/target', 'target')
  await symlink('target', path.join(runtime, 'browser', 'linked'))
  const files = [...inventory(), { path: 'browser/linked', bytes: 6, sha256: digest('target'), symlink: 'browser/target' }]
  const result = await attributeRuntimeLicenses({ runtimeRoot: runtime, files, licenses: [files.find(file => file.path === license)] })

  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ path: license, disposition: 'legal_review_required', attribution: { status: 'attributed' } })
  expect(result[0].attribution.owners[0]).toMatchObject({
    distribution: 'Example Package',
    version: '1.2.3',
    metadata: {
      licenseExpression: { value: 'MIT' },
      licenseFiles: [{ declared: 'LICENSE.txt', path: `${dist}/LICENSE.txt`, status: 'present_in_inventory' }]
    }
  })
  expect(result[0].attribution.owners[0].metadata).not.toHaveProperty('body')
})

it('keeps malformed and conflicting record ownership explicit and unresolved', async () => {
  const { runtime, write, inventory } = await fixture()
  const license = `${sitePackages}/example_pkg/LICENSE`
  await write(license, 'license evidence')
  for (const dist of ['first-1.dist-info', 'second-1.dist-info']) {
    await write(`${sitePackages}/${dist}/METADATA`, `Name: ${dist}\nVersion: 1\nLicense: MIT\n`)
    await write(`${sitePackages}/${dist}/RECORD`, 'example_pkg/LICENSE,,\n')
  }
  const files = inventory()
  let result = await attributeRuntimeLicenses({ runtimeRoot: runtime, files, licenses: [license] })
  expect(result[0].attribution).toMatchObject({ status: 'unresolved', reasons: ['conflicting_record_owners'] })
  expect(result[0].disposition).toBe('legal_review_required')

  await write(`${sitePackages}/broken-1.dist-info/RECORD`, '"example_pkg/LICENSE,unterminated\n')
  await write(`${sitePackages}/broken-1.dist-info/METADATA`, 'Name: broken\nVersion: 1\n')
  const malformedFiles = inventory()
  result = await attributeRuntimeLicenses({ runtimeRoot: runtime, files: malformedFiles, licenses: [license] })
  expect(result[0].attribution).toMatchObject({ status: 'unresolved', reasons: expect.arrayContaining(['malformed_record']) })
})

it('rejects an escaping or symlink inventory input before it reads runtime metadata', async () => {
  const { runtime, write, inventory } = await fixture()
  await write(`${sitePackages}/example/LICENSE`, 'license evidence')
  await write(`${sitePackages}/example-1.dist-info/RECORD`, 'example/LICENSE,,\n')
  await write(`${sitePackages}/example-1.dist-info/METADATA`, 'Name: example\n')
  const files = inventory()
  await expect(attributeRuntimeLicenses({
    runtimeRoot: runtime,
    files: [...files, { path: '../outside', bytes: 0, sha256: 'a'.repeat(64) }],
    licenses: []
  })).rejects.toThrow('runtime_license_attribution_invalid:unsafe_relative_path')

  const selectedSymlink = await attributeRuntimeLicenses({
    runtimeRoot: runtime,
    files: files.map(file => file.path.endsWith('/LICENSE') ? { ...file, symlink: 'somewhere-inside' } : file),
    licenses: [`${sitePackages}/example/LICENSE`]
  })
  expect(selectedSymlink[0].attribution).toMatchObject({ status: 'unresolved', reasons: ['symlink_candidate'] })

  await writeFile(path.join(runtime, `${sitePackages}/example-1.dist-info/RECORD`), 'example/LICENCE,,\n', 'utf8')
  await expect(attributeRuntimeLicenses({
    runtimeRoot: runtime,
    files,
    licenses: [`${sitePackages}/example/LICENSE`]
  })).rejects.toThrow(`runtime_license_attribution_invalid:inventory_digest_changed:${sitePackages}/example-1.dist-info/RECORD`)

  const metadata = path.join(runtime, `${sitePackages}/example-1.dist-info/METADATA`)
  await rm(metadata)
  await symlink('/tmp', metadata)
  await expect(attributeRuntimeLicenses({
    runtimeRoot: runtime,
    files: files.map(file => file.path.endsWith('/RECORD') ? { ...file, symlink: 'outside' } : file),
    licenses: [`${sitePackages}/example/LICENSE`]
  })).rejects.toThrow(`runtime_license_attribution_invalid:symlink_input:${sitePackages}/example-1.dist-info/RECORD`)
})

it('parses folded semantic headers without treating absent license fields as clearance', async () => {
  const { runtime, write, inventory } = await fixture()
  const license = `${sitePackages}/example/LICENSE`
  const dist = `${sitePackages}/example-1.dist-info`
  await write(license, 'license evidence')
  await write(`${dist}/RECORD`, 'example/LICENSE,,\n')
  await write(`${dist}/METADATA`, 'Name: Example\nVersion: 1\nSummary: ignored\n continuation\n\nlicense body is not evidence')
  const files = inventory()
  const result = await attributeRuntimeLicenses({ runtimeRoot: runtime, files, licenses: [license] })

  expect(result[0]).toMatchObject({ disposition: 'legal_review_required', attribution: { status: 'attributed' } })
  expect(result[0].attribution.owners[0].metadata).not.toHaveProperty('licenseExpression')
  expect(result[0].attribution.owners[0].metadata).not.toHaveProperty('license')
})
