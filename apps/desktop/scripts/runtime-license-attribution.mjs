import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'

const SITE_PACKAGES = 'python/lib/python3.14/site-packages'
const RECORD_SUFFIX = '.dist-info/RECORD'
const MAX_RECORD_BYTES = 4 * 1024 * 1024
const MAX_METADATA_BYTES = 256 * 1024
const MAX_SEMANTIC_VALUE_BYTES = 250

const invalid = detail => new Error(`runtime_license_attribution_invalid:${detail}`)

function relativePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw invalid('unsafe_relative_path')
  }
  return value
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function compare(left, right) {
  return left.localeCompare(right, 'en')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function utf8(content, sourcePath, kind) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw invalid(`malformed_${kind}:${sourcePath}`)
  }
}

function validateFiles(files) {
  if (!Array.isArray(files)) throw invalid('files')
  const byPath = new Map()
  for (const file of files) {
    if (!file || typeof file !== 'object') throw invalid('file_inventory')
    const filePath = relativePath(file.path)
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw invalid(`file_inventory:${filePath}`)
    }
    if (byPath.has(filePath)) throw invalid(`duplicate_file:${filePath}`)
    const symlink = Object.prototype.hasOwnProperty.call(file, 'symlink') ? relativePath(file.symlink) : null
    byPath.set(filePath, { path: filePath, bytes: file.bytes, sha256: file.sha256, symlink })
  }
  return byPath
}

function normalizeLicenses(licenses, byPath) {
  if (!Array.isArray(licenses)) throw invalid('licenses')
  const selected = new Set()
  for (const license of licenses) {
    const licensePath = typeof license === 'string' ? relativePath(license) : relativePath(license?.path)
    if (!byPath.has(licensePath)) throw invalid(`license_not_in_inventory:${licensePath}`)
    selected.add(licensePath)
  }
  return [...selected]
    .filter(filePath => filePath.startsWith(`${SITE_PACKAGES}/`))
    .sort(compare)
}

async function readInventoryFile({ root, realRoot, file, limit }) {
  if (file.symlink) throw invalid(`symlink_input:${file.path}`)
  if (file.bytes > limit) throw invalid(`read_limit:${file.path}`)
  const candidate = path.resolve(root, file.path)
  if (!inside(root, candidate)) throw invalid(`path_escapes_root:${file.path}`)
  const resolved = await realpath(candidate).catch(error => {
    if (error.code === 'ENOENT') throw invalid(`missing_inventory_file:${file.path}`)
    throw error
  })
  // `runtimeRoot` can arrive through macOS's /var → /private/var alias, so
  // compare against the real root rather than its spelling supplied by caller.
  if (!inside(realRoot, resolved) || resolved !== path.resolve(realRoot, file.path)) throw invalid(`symlink_path:${file.path}`)
  const linkInfo = await lstat(candidate)
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || linkInfo.size !== file.bytes) throw invalid(`inventory_file_changed:${file.path}`)

  const handle = await open(candidate, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== file.bytes || info.size > limit) throw invalid(`inventory_file_changed:${file.path}`)
    const content = Buffer.alloc(info.size)
    let offset = 0
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset)
      if (!bytesRead) throw invalid(`inventory_file_changed:${file.path}`)
      offset += bytesRead
    }
    if (sha256(content) !== file.sha256) throw invalid(`inventory_digest_changed:${file.path}`)
    return content
  } finally {
    await handle.close()
  }
}

/** Parse an RFC 4180 record without accepting malformed quote sequences. */
function parseCsv(text, sourcePath) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let afterQuote = false
  let atStart = true

  const finishField = () => {
    row.push(field)
    field = ''
    atStart = true
    afterQuote = false
  }
  const finishRow = () => {
    finishField()
    if (row.length !== 3 || !row[0]) throw invalid(`malformed_record:${sourcePath}`)
    rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
          afterQuote = true
        }
      } else {
        field += character
      }
      continue
    }
    if (afterQuote && character !== ',' && character !== '\n' && character !== '\r') throw invalid(`malformed_record:${sourcePath}`)
    if (character === ',') {
      finishField()
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      finishRow()
    } else if (character === '"') {
      if (!atStart) throw invalid(`malformed_record:${sourcePath}`)
      quoted = true
      atStart = false
    } else {
      field += character
      atStart = false
    }
  }
  if (quoted) throw invalid(`malformed_record:${sourcePath}`)
  if (field || row.length || afterQuote || !atStart) finishRow()
  if (!rows.length) throw invalid(`malformed_record:${sourcePath}`)
  return rows
}

function recordPathInsideRuntime({ root, recordPath, sourcePath }) {
  if (typeof recordPath !== 'string' || !recordPath || recordPath.includes('\\') || recordPath.includes('\0') || path.posix.isAbsolute(recordPath)) {
    throw invalid(`malformed_record:${sourcePath}`)
  }
  const candidate = path.resolve(root, SITE_PACKAGES, ...recordPath.split('/'))
  if (!inside(root, candidate)) throw invalid(`malformed_record:${sourcePath}`)
  return path.relative(root, candidate).split(path.sep).join('/')
}

function semanticValue(value) {
  const bytes = Buffer.byteLength(value, 'utf8')
  return bytes <= MAX_SEMANTIC_VALUE_BYTES
    ? { value }
    : { bytes, sha256: sha256(value) }
}

function parseMetadata(content, sourcePath) {
  const text = utf8(content, sourcePath, 'metadata')
  const lines = text.split(/\r?\n/u)
  const headers = new Map()
  let current = null
  for (const line of lines) {
    if (!line) break
    if (/^[ \t]/u.test(line)) {
      if (!current) throw invalid(`malformed_metadata:${sourcePath}`)
      headers.get(current).push(line.trim())
      continue
    }
    const separator = line.indexOf(':')
    if (separator <= 0) throw invalid(`malformed_metadata:${sourcePath}`)
    current = line.slice(0, separator).toLowerCase()
    const values = headers.get(current) || []
    values.push(line.slice(separator + 1).trim())
    headers.set(current, values)
  }
  const value = name => headers.get(name)?.map(item => item.trim()).join(' ') || null
  return {
    name: value('name'),
    version: value('version'),
    licenseExpression: value('license-expression'),
    license: value('license'),
    licenseFiles: headers.get('license-file') || []
  }
}

function metadataLicenseFiles({ metadata, distInfo, byPath }) {
  const files = []
  for (const declared of metadata.licenseFiles) {
    const bounded = semanticValue(declared)
    if (!bounded.value) {
      files.push({ declared: bounded, status: 'value_too_long' })
      continue
    }
    let declaredPath
    try {
      declaredPath = relativePath(bounded.value)
    } catch {
      files.push({ declared: bounded.value, status: 'invalid_path' })
      continue
    }
    const filePath = `${distInfo}/${declaredPath}`
    const inventory = byPath.get(filePath)
    files.push(inventory
      ? { declared: declaredPath, path: inventory.path, bytes: inventory.bytes, sha256: inventory.sha256, status: 'present_in_inventory' }
      : { declared: declaredPath, path: filePath, status: 'missing_from_inventory' })
  }
  return files.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'))
}

function ownerEvidence(owner) {
  const metadata = {
    path: owner.metadataFile.path,
    sha256: owner.metadataFile.sha256,
    name: owner.semantic.name ? semanticValue(owner.semantic.name) : null,
    version: owner.semantic.version ? semanticValue(owner.semantic.version) : null,
    ...(owner.semantic.licenseExpression ? { licenseExpression: semanticValue(owner.semantic.licenseExpression) } : {}),
    ...(!owner.semantic.licenseExpression && owner.semantic.license ? { license: semanticValue(owner.semantic.license) } : {}),
    licenseFiles: metadataLicenseFiles({ metadata: owner.semantic, distInfo: owner.distInfo, byPath: owner.byPath })
  }
  return {
    distribution: metadata.name?.value || null,
    version: metadata.version?.value || null,
    record: { path: owner.recordFile.path, sha256: owner.recordFile.sha256 },
    metadata
  }
}

/**
 * Attribute staged Python license artifacts to their installed distributions.
 *
 * This preserves evidence only. It deliberately never interprets metadata as
 * permission, validates an SPDX claim, or clears a release for redistribution.
 */
export async function attributeRuntimeLicenses({ runtimeRoot, files, licenses } = {}) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot) throw invalid('runtime_root')
  const root = path.resolve(runtimeRoot)
  const rootInfo = await lstat(root).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw invalid('runtime_root')
  const realRoot = await realpath(root)
  const byPath = validateFiles(files)
  const candidates = normalizeLicenses(licenses, byPath)
  const records = [...byPath.values()]
    .filter(file => file.path.startsWith(`${SITE_PACKAGES}/`) && file.path.endsWith(RECORD_SUFFIX))
    .sort((left, right) => compare(left.path, right.path))

  const ownersByCandidate = new Map(candidates.map(candidate => [candidate, []]))
  const attributableCandidates = new Set(candidates.filter(candidate => !byPath.get(candidate).symlink))
  const malformedRecords = []
  for (const recordFile of records) {
    const distInfo = recordFile.path.slice(0, -'/RECORD'.length)
    const metadataFile = byPath.get(`${distInfo}/METADATA`)
    let rows
    try {
      rows = parseCsv(utf8(await readInventoryFile({ root, realRoot, file: recordFile, limit: MAX_RECORD_BYTES }), recordFile.path, 'record'), recordFile.path)
    } catch (error) {
      if (error.message?.startsWith('runtime_license_attribution_invalid:malformed_record:')) {
        malformedRecords.push({ path: recordFile.path, sha256: recordFile.sha256 })
        continue
      }
      throw error
    }
    let ownedPaths
    try {
      ownedPaths = new Set(rows.map(row => recordPathInsideRuntime({ root, recordPath: row[0], sourcePath: recordFile.path })))
    } catch (error) {
      if (error.message?.startsWith('runtime_license_attribution_invalid:malformed_record:')) {
        malformedRecords.push({ path: recordFile.path, sha256: recordFile.sha256 })
        continue
      }
      throw error
    }
    const ownedCandidates = candidates.filter(candidate => attributableCandidates.has(candidate) && ownedPaths.has(candidate))
    if (!ownedCandidates.length) continue
    if (!metadataFile) {
      for (const candidate of ownedCandidates) ownersByCandidate.get(candidate).push({ recordFile, metadataFile: null, distInfo })
      continue
    }
    const semantic = parseMetadata(await readInventoryFile({ root, realRoot, file: metadataFile, limit: MAX_METADATA_BYTES }), metadataFile.path)
    for (const candidate of ownedCandidates) ownersByCandidate.get(candidate).push({ recordFile, metadataFile, semantic, distInfo, byPath })
  }

  return candidates.map(candidate => {
    const candidateFile = byPath.get(candidate)
    const owners = ownersByCandidate.get(candidate)
    if (candidateFile.symlink) {
      return {
        path: candidate,
        bytes: candidateFile.bytes,
        sha256: candidateFile.sha256,
        disposition: 'legal_review_required',
        attribution: { status: 'unresolved', reasons: ['symlink_candidate'], malformedRecords, owners: [] }
      }
    }
    const malformed = malformedRecords.length > 0
    if (malformed || owners.length !== 1 || !owners[0].metadataFile) {
      const reasons = [
        ...(malformed ? ['malformed_record'] : []),
        ...(owners.length === 0 ? ['unmapped_record'] : []),
        ...(owners.length > 1 ? ['conflicting_record_owners'] : []),
        ...(owners.length === 1 && !owners[0].metadataFile ? ['metadata_missing_from_inventory'] : [])
      ]
      return {
        path: candidate,
        bytes: candidateFile.bytes,
        sha256: candidateFile.sha256,
        disposition: 'legal_review_required',
        attribution: {
          status: 'unresolved',
          reasons,
          malformedRecords,
          owners: owners.filter(owner => owner.metadataFile).map(ownerEvidence).sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)))
        }
      }
    }
    return {
      path: candidate,
      bytes: candidateFile.bytes,
      sha256: candidateFile.sha256,
      disposition: 'legal_review_required',
      attribution: { status: 'attributed', owners: [ownerEvidence(owners[0])] }
    }
  })
}
