import { describe, expect, it } from 'vitest'

import { cargoLicense, parseCargoLock, renderCrateNotice, untar } from './rust-crate-notices.mjs'

function tarEntry(name, content) {
  const header = Buffer.alloc(512)
  const body = Buffer.from(content)
  header.write(name, 0, 'utf8')
  header.write(body.length.toString(8).padStart(11, '0'), 124, 'utf8')
  header.write('0', 156, 'utf8')

  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}

describe('the Rust crate notice', () => {
  it('reads every external package of a Cargo.lock', () => {
    const lock = parseCargoLock(
      [
        '[[package]]',
        'name = "app"',
        'version = "1.0.0"',
        '',
        '[[package]]',
        'name = "serde"',
        'version = "1.0.200"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "abc"',
        '',
        '[metadata]',
        'name = "not-a-package"'
      ].join('\n')
    )

    expect(lock).toEqual([
      { name: 'app', version: '1.0.0' },
      {
        name: 'serde',
        version: '1.0.200',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        checksum: 'abc'
      }
    ])
  })

  it('reads a crate archive and its declared licence', () => {
    const archive = Buffer.concat([
      tarEntry('serde-1.0.200/Cargo.toml', '[package]\nname = "serde"\nlicense = "MIT OR Apache-2.0"\n'),
      tarEntry('serde-1.0.200/LICENSE-MIT', 'MIT text\n'),
      Buffer.alloc(1024)
    ])
    const files = untar(archive)

    expect(files.map(file => file.name)).toEqual(['serde-1.0.200/Cargo.toml', 'serde-1.0.200/LICENSE-MIT'])
    expect(cargoLicense(files[0].data.toString('utf8'))).toBe('MIT OR Apache-2.0')
    expect(cargoLicense('[package]\nlicense-file = "LICENSE.txt"\n')).toBe('see LICENSE.txt')
  })

  it('prints each distinct licence text once, and refuses a crate with neither a file nor a standard text', () => {
    const notice = renderCrateNotice({
      title: 'Rust crates in fixture',
      lockUrl: 'https://example.test/Cargo.lock',
      crates: [
        { name: 'a', version: '1.0.0', license: 'MIT', licenseFiles: [{ name: 'LICENSE', text: 'Shared MIT text\n' }] },
        {
          name: 'b',
          version: '2.0.0',
          license: 'MIT',
          licenseFiles: [{ name: 'LICENSE', text: 'Shared  MIT text\n' }]
        },
        { name: 'c', version: '3.0.0', license: 'Apache-2.0', licenseFiles: [] }
      ]
    })

    expect(notice.split('Shared MIT text').length - 1).toBe(1)
    expect(notice).toContain('For: a 1.0.0, b 2.0.0')
    expect(notice).toContain('texts/Apache-2.0.txt')
    expect(() =>
      renderCrateNotice({
        title: 'x',
        lockUrl: 'https://example.test/Cargo.lock',
        crates: [{ name: 'd', version: '1.0.0', license: 'ISC', licenseFiles: [] }]
      })
    ).toThrow('crate_license_text_missing:d')
  })
})
