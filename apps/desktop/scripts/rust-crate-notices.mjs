#!/usr/bin/env node
/**
 * Maintenance tool for the open-source notices (FD3): writes the licence notice of the Rust
 * crates compiled into a shipped binary, from the Cargo.lock of the exact release that built it.
 *
 * Every registry crate of the lockfile is downloaded from crates.io, checked against the lockfile
 * checksum, and its top-level licence files are copied word for word. A crate taken from git uses
 * the licence files of that repository at the locked commit. The output lists every crate of the
 * lockfile, so it can include crates that are built only for other platforms or only at build
 * time; it never leaves one out.
 *
 *   node scripts/rust-crate-notices.mjs --lock <Cargo.lock URL> --package <name@version> \
 *     --binary <what ships> --out third-party/licenses/rust/<name>-<version>.txt
 *
 * Nothing here runs during a build: the output is committed and shipped like the other texts.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|unlicense|copyright)(?:[.\-_].*)?$/iu
const RULE = '='.repeat(78)
const LINE = '-'.repeat(78)
const CONCURRENCY = 8

/** The [[package]] entries of a Cargo.lock (TOML), enough of it for a notice. */
export function parseCargoLock(text) {
  const packages = []
  let current = null

  for (const raw of text.split('\n')) {
    const line = raw.trim()

    if (line === '[[package]]') {
      current = {}
      packages.push(current)
    } else if (line.startsWith('[')) {
      current = null
    } else if (current) {
      const match = /^(name|version|source|checksum)\s*=\s*"([^"]*)"$/u.exec(line)

      if (match) {
        current[match[1]] = match[2]
      }
    }
  }

  return packages.filter(item => item.name && item.version)
}

/** The files of a tar archive (ustar and pax long names). */
export function untar(buffer) {
  const files = []
  let offset = 0
  let longName = null

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)

    if (header.every(byte => byte === 0)) {
      break
    }

    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/su, '')
    const size = Number.parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1) || '0'
    const prefix = field(345, 155)
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    const body = buffer.subarray(offset + 512, offset + 512 + size)
    longName = null

    if (type === 'x') {
      const match = /\d+ path=([^\n]*)\n/u.exec(body.toString('utf8'))
      longName = match ? match[1] : null
    } else if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/su, '')
    } else if (type === '0' || type === '') {
      files.push({ name, data: body })
    }

    offset += 512 + Math.ceil(size / 512) * 512
  }

  return files
}

/** The licence id a crate's Cargo.toml declares (`license`, or the file `license-file` names). */
export function cargoLicense(manifest) {
  let section = ''

  for (const raw of manifest.split('\n')) {
    const line = raw.trim()

    if (line.startsWith('[')) {
      section = line
    } else if (section === '[package]') {
      const match = /^(license|license-file)\s*=\s*"([^"]*)"$/u.exec(line)

      if (match) {
        return match[1] === 'license' ? match[2] : `see ${match[2]}`
      }
    }
  }

  return null
}

async function fetchBuffer(url) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      headers: { 'user-agent': 'atum-third-party-notices (support@atumplatform.com)' }
    })

    if (response.ok) {
      return Buffer.from(await response.arrayBuffer())
    }

    if (attempt >= 3 || response.status === 404) {
      throw new Error(`fetch_failed:${response.status}:${url}`)
    }

    await new Promise(resolve => setTimeout(resolve, attempt * 1000))
  }
}

async function registryCrate(item) {
  const archive = await fetchBuffer(`https://static.crates.io/crates/${item.name}/${item.name}-${item.version}.crate`)
  const digest = createHash('sha256').update(archive).digest('hex')

  if (item.checksum && digest !== item.checksum) {
    throw new Error(`crate_checksum_mismatch:${item.name}@${item.version}`)
  }

  const root = `${item.name}-${item.version}/`
  const files = untar(gunzipSync(archive)).filter(file => file.name.startsWith(root))
  const manifest = files.find(file => file.name === `${root}Cargo.toml`)
  const licenseFiles = files
    .filter(file => !file.name.slice(root.length).includes('/') && LICENSE_FILE.test(file.name.slice(root.length)))
    .map(file => ({ name: file.name.slice(root.length), text: file.data.toString('utf8') }))
    .sort((left, right) => (left.name < right.name ? -1 : 1))

  return { ...item, license: manifest ? cargoLicense(manifest.data.toString('utf8')) : null, licenseFiles }
}

const gitLicenses = new Map()

async function gitCrate(item) {
  const match = /^git\+https:\/\/github\.com\/([^/#?]+\/[^/#?]+?)(?:\.git)?\/?(?:\?[^#]*)?#([a-f0-9]{40})$/u.exec(
    item.source
  )

  if (!match) {
    throw new Error(`git_source_unsupported:${item.source}`)
  }

  const [, repository, commit] = match
  const key = `${repository}@${commit}`

  if (!gitLicenses.has(key)) {
    gitLicenses.set(
      key,
      (async () => {
        const tree = JSON.parse(
          (await fetchBuffer(`https://api.github.com/repos/${repository}/git/trees/${commit}`)).toString('utf8')
        )
        const names = tree.tree
          .filter(entry => entry.type === 'blob' && LICENSE_FILE.test(entry.path))
          .map(entry => entry.path)

        return Promise.all(
          names.sort().map(async name => ({
            name,
            text: (await fetchBuffer(`https://raw.githubusercontent.com/${repository}/${commit}/${name}`)).toString(
              'utf8'
            )
          }))
        )
      })()
    )
  }

  return {
    ...item,
    license: `see the licence of ${repository}`,
    licenseFiles: await gitLicenses.get(key),
    repository,
    commit
  }
}

async function mapLimited(items, limit, task) {
  const results = new Array(items.length)
  let next = 0

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await task(items[index])
      }
    })
  )

  return results
}

function normalize(text) {
  return text.replace(/\r\n?/gu, '\n').replace(/\s+$/u, '')
}

function wrap(text, width = 78) {
  const lines = []
  let line = ''

  for (const word of text.split(/\s+/u).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }

  if (line) {
    lines.push(line)
  }

  return lines.join('\n')
}

const STANDARD_TEXTS = { MIT: 'texts/MIT.txt', 'Apache-2.0': 'texts/Apache-2.0.txt', 'MPL-2.0': 'texts/MPL-2.0.txt' }

/** The notice text for a set of crates (deterministic for the same crates). */
export function renderCrateNotice({ title, lockUrl, crates }) {
  const out = [`${title}\n${RULE}\n\n`]
  out.push(
    wrap(
      `These Rust crates are listed in the Cargo.lock that built it (${lockUrl}). The list includes every crate of that lockfile, so some are used only on other platforms or only while building. Each crate's own licence files follow, copied word for word; each distinct text is printed once, with the crates it covers. The source of each crate from crates.io, at the version listed, is at https://crates.io/crates/<name>/<version>; a crate from git names its repository and commit.`
    ),
    '\n\n'
  )

  for (const crate of crates) {
    const from = crate.repository ? `, from ${crate.repository} at ${crate.commit}` : ''
    out.push(`  ${crate.name} ${crate.version} (${crate.license ?? 'no licence declared'}${from})\n`)
  }

  // Each distinct licence file is printed once, with every crate that ships it; a crate with
  // two files (LICENSE-APACHE and LICENSE-MIT) appears under both.
  const groups = new Map()
  const add = (key, entry, crate) => {
    const group = groups.get(key) ?? { ...entry, members: [] }
    group.members.push(crate)
    groups.set(key, group)
  }

  for (const crate of crates) {
    if (!crate.licenseFiles.length) {
      add(`declared:${crate.license}`, { text: null, name: null, license: crate.license }, crate)
      continue
    }

    for (const file of crate.licenseFiles) {
      const text = normalize(file.text)
      add(createHash('sha256').update(text.replace(/\s+/gu, ' ')).digest('hex'), { text, name: file.name }, crate)
    }
  }

  const sorted = [...groups.values()].sort((left, right) => {
    const a = `${left.members[0].name}@${left.members[0].version}:${left.name}`
    const b = `${right.members[0].name}@${right.members[0].version}:${right.name}`

    return a < b ? -1 : a > b ? 1 : 0
  })

  for (const group of sorted) {
    out.push('\n', LINE, '\n')
    out.push(wrap(`For: ${group.members.map(member => `${member.name} ${member.version}`).join(', ')}`), '\n\n')

    if (group.text) {
      out.push(`[${group.name}]\n\n`, group.text, '\n')
    } else {
      const ids = (group.license ?? '').split(/\s+(?:OR|AND|WITH)\s+|\s*\/\s*|[()]/u).filter(Boolean)
      const standard = ids.map(id => STANDARD_TEXTS[id]).filter(Boolean)

      if (!standard.length) {
        throw new Error(`crate_license_text_missing:${group.members.map(member => member.name).join(',')}`)
      }

      out.push(
        wrap(
          `These crates ship no licence file. Cargo.toml declares ${group.license}; the standard text is ${standard.join(' and ')} in this folder.`
        ),
        '\n'
      )
    }
  }

  return out.join('')
}

function flag(args, name) {
  const index = args.indexOf(name)

  return index === -1 ? undefined : args[index + 1]
}

async function main(args = process.argv.slice(2)) {
  const lockUrl = flag(args, '--lock')
  const packageId = flag(args, '--package')
  const binary = flag(args, '--binary')
  const out = flag(args, '--out')

  if (!lockUrl || !packageId || !binary || !out) {
    throw new Error('Usage: rust-crate-notices.mjs --lock URL --package NAME@VERSION --binary WHAT --out FILE')
  }

  const lock = parseCargoLock((await fetchBuffer(lockUrl)).toString('utf8'))
  const external = lock.filter(item => item.source)
  const crates = await mapLimited(external, CONCURRENCY, item =>
    item.source.startsWith('registry+') ? registryCrate(item) : gitCrate(item)
  )

  crates.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : left.version < right.version ? -1 : 1
  )
  const text = renderCrateNotice({ title: `Rust crates in ${binary} (${packageId})`, lockUrl, crates })
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  writeFileSync(path.resolve(out), `${text}`)
  process.stdout.write(`${JSON.stringify({ out, crates: crates.length, bytes: Buffer.byteLength(text) })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[rust-crate-notices] ${error.message}`)
    process.exitCode = 1
  })
}
