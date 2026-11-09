import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

function getField(value, field) {
  return field.split('.').reduce((current, key) => current && typeof current === 'object' ? current[key] : undefined, value)
}

function cleanVersion(value) {
  return String(value ?? '').replace(/^[~^=v\s]+/, '')
}

function imageTag(value) {
  const image = String(value ?? '').split('@', 1)[0]
  const colon = image.lastIndexOf(':')
  const slash = image.lastIndexOf('/')
  return colon > slash ? image.slice(colon + 1) : null
}

function comparablePin(component, pin) {
  const value = pin?.[0]?.value
  return component.comparison === 'image-tag' ? imageTag(value) : value
}

function withTimeout(promise, timeoutMs, source) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${source} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function parseComposeImage(text, service) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => new RegExp(`^(\\s+)${service}:\\s*(?:#.*)?$`).test(line))
  if (start < 0) return null
  const indent = lines[start].match(/^(\s+)/)?.[1].length ?? 0
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0
    if (lineIndent <= indent) break
    const image = line.match(/^\s*image:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/)?.[1]
    if (image) return image
  }
  return null
}

export async function resolveLocators(component, repoRoot, repositories = {}) {
  const evidence = []
  for (const locator of component.locators ?? []) {
    const root = locator.repository ? repositories[locator.repository] : repoRoot
    if (!root) {
      evidence.push({ locator, status: 'unknown', reason: `repository ${locator.repository} was not supplied` })
      continue
    }
    const path = resolve(root, locator.path)
    try {
      if (locator.kind === 'json') {
        const value = getField(await readJson(path), locator.field)
        evidence.push(value === undefined
          ? { locator, status: 'unknown', reason: `field ${locator.field} is absent` }
          : { locator, status: 'observed', value: String(value), path })
      } else if (locator.kind === 'sha256') {
        const value = createHash('sha256').update(await readFile(path)).digest('hex')
        evidence.push({ locator, status: 'observed', value, path })
      } else if (locator.kind === 'package') {
        const packageJson = await readJson(path)
        const value = packageJson?.[locator.section]?.[locator.name]
        evidence.push(value === undefined
          ? { locator, status: 'unknown', reason: `${locator.section}.${locator.name} is absent` }
          : { locator, status: 'observed', value: String(value), path })
      } else if (locator.kind === 'lock-package') {
        const lock = await readJson(path)
        const value = lock?.packages?.[locator.packagePath]?.version
        evidence.push(value === undefined
          ? { locator, status: 'unknown', reason: `lock package ${locator.packagePath} is absent` }
          : { locator, status: 'observed', value: String(value), path })
      } else if (locator.kind === 'compose-image') {
        const value = parseComposeImage(await readFile(path, 'utf8'), locator.service)
        evidence.push(value
          ? { locator, status: 'observed', value, path }
          : { locator, status: 'unknown', reason: `service ${locator.service} has no image pin` })
      } else {
        evidence.push({ locator, status: 'unknown', reason: `unsupported locator ${locator.kind}` })
      }
    } catch (error) {
      evidence.push({ locator, status: 'unknown', reason: error.code === 'ENOENT' ? `missing ${locator.path}` : error.message })
    }
  }
  return evidence
}

function observedPin(evidence) {
  const found = evidence.filter(item => item.status === 'observed')
  return found.length ? found.map(item => ({ value: item.value, label: item.locator.label ?? item.locator.name ?? item.locator.service ?? item.locator.field, path: item.path })) : null
}

function candidateKey(candidate) {
  return candidate ? `${candidate.version ?? ''}\u0000${candidate.url ?? ''}` : null
}

function releaseResult(raw) {
  return { version: raw.tag_name ?? raw.name, url: raw.html_url, publishedAt: raw.published_at ?? null, prerelease: raw.prerelease === true }
}

export async function createLiveFetchers({ github = ghApi, fetchImpl = fetch, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  return {
    async release(source) {
      const raw = await withTimeout(github(`repos/${source.repository}/releases/latest`), timeoutMs, 'GitHub release request')
      return releaseResult(raw)
    },
    async npm(source) {
      const response = await withTimeout(fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(source.package)}/latest`, {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs)
      }), timeoutMs, 'npm registry request')
      if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
      const raw = await response.json()
      return { version: raw.version, url: `https://www.npmjs.com/package/${source.package}/v/${raw.version}`, publishedAt: null, prerelease: false }
    },
    async advisories(repository) {
      if (!repository) throw new Error('origin GitHub repository is unknown')
      const alerts = await withTimeout(github(`repos/${repository}/dependabot/alerts?state=open&per_page=100`, { paginate: true }), timeoutMs, 'GitHub advisory request')
      return Array.isArray(alerts) ? alerts.flat() : alerts
    }
  }
}

async function ghApi(path, { paginate = false } = {}) {
  const args = ['api', '--method', 'GET', ...(paginate ? ['--paginate', '--slurp'] : []), path]
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 2 * 1024 * 1024, timeout: DEFAULT_REQUEST_TIMEOUT_MS })
  const result = JSON.parse(stdout)
  return paginate && Array.isArray(result) ? result.flat() : result
}

export async function originRepository(repoRoot, run = execFileAsync) {
  try {
    const { stdout } = await run('git', ['config', '--get', 'remote.origin.url'], { cwd: repoRoot })
    const value = stdout.trim().replace(/\.git$/, '')
    return value.match(/github\.com[/:]([^/]+\/[^/]+)$/)?.[1] ?? null
  } catch {
    return null
  }
}

function relevantAlerts(alerts, component) {
  const packages = component.advisory?.packages
  if (!Array.isArray(packages) || !Array.isArray(alerts)) return []
  return alerts.filter(alert => packages.includes(alert?.dependency?.package?.name)).map(alert => ({
    id: alert.security_advisory?.ghsa_id ?? alert.security_advisory?.cve_id ?? 'GitHub advisory',
    url: alert.security_advisory?.html_url ?? alert.html_url ?? null,
    summary: alert.security_advisory?.summary ?? 'Open Dependabot alert'
  }))
}

function advisoryCoverage(component, advisoryError, offline, previous) {
  if (component.advisory?.kind !== 'dependabot') {
    return { status: 'unknown', reason: component.advisory?.reason ?? 'This component is not covered by repository Dependabot alerts.' }
  }
  if (offline) return { status: 'unknown', reason: 'offline requested', ...(previous?.advisories?.length ? { freshness: 'retained-unknown' } : {}) }
  if (advisoryError) return { status: 'unknown', reason: advisoryError, ...(previous?.advisories?.length ? { freshness: 'retained-unknown' } : {}) }
  return { status: 'observed' }
}

function sourceFailure(error) {
  return error instanceof Error ? error.message : String(error)
}

function componentStatus({ component, pin, latest, failed, advisories }) {
  if (component.source?.kind === 'unknown' || !pin) return 'unknown'
  if (failed) return 'stale'
  if (advisories.length) return 'security-review'
  const current = comparablePin(component, pin)
  if (!latest?.version) return 'unknown'
  if (component.source.kind === 'npm' && cleanVersion(current) === cleanVersion(latest.version)) return 'current'
  if (component.source.kind === 'github-release' && cleanVersion(current) === cleanVersion(latest.version)) return 'current'
  return 'review-release'
}

function observationFingerprint({ pin, latest, advisories, advisoryCoverage, status }) {
  return JSON.stringify({
    pin: pin?.map(item => item.value) ?? [],
    candidate: candidateKey(latest),
    advisories: advisories.map(advisory => advisory.id).sort(),
    advisoryCoverage: advisoryCoverage.status,
    status
  })
}

function stateEntry(previous, latest, pin, advisories, advisoryCoverage, status, now, fetched) {
  const candidate = latest ?? previous?.latest ?? null
  const key = candidateKey(candidate)
  const fingerprint = observationFingerprint({ pin, latest: candidate, advisories, advisoryCoverage, status })
  const previousFingerprint = previous?.fingerprint
  const legacyUnchanged = previous && !previousFingerprint &&
    previous.candidateKey === key && previous.lastStatus === status && advisories.length === 0
  return {
    ...previous,
    latest: candidate,
    candidateKey: key,
    advisories,
    advisoryCoverage,
    fingerprint,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastObservedAt: now,
    ...(fetched ? { lastSuccessAt: now } : {}),
    lastStatus: status,
    change: !previous ? 'new' : (!previousFingerprint ? (legacyUnchanged ? 'unchanged' : 'changed') : (fingerprint === previousFingerprint ? 'unchanged' : 'changed'))
  }
}

export async function buildReport({ repoRoot, inventory, repositories = {}, previousState = {}, fetchers, now = new Date().toISOString(), offline = false, repository } = {}) {
  const components = inventory.components ?? []
  const origin = repository ?? await originRepository(repoRoot)
  let alerts = null
  let advisoryError = null
  if (!offline) {
    try { alerts = await fetchers.advisories(origin) } catch (error) { advisoryError = sourceFailure(error) }
  }
  const stateComponents = previousState.components ?? {}
  const reportComponents = []
  const nextComponents = { ...stateComponents }
  for (const component of components) {
    const evidence = await resolveLocators(component, repoRoot, repositories)
    const pin = observedPin(evidence)
    const previous = stateComponents[component.id]
    let latest = null
    let failure = offline ? 'offline requested' : null
    if (!offline && component.source?.kind === 'github-release') {
      try { latest = await fetchers.release(component.source) } catch (error) { failure = sourceFailure(error) }
    } else if (!offline && component.source?.kind === 'npm') {
      try { latest = await fetchers.npm(component.source) } catch (error) { failure = sourceFailure(error) }
    }
    const effectiveLatest = latest ?? previous?.latest ?? null
    const coverage = advisoryCoverage(component, advisoryError, offline, previous)
    const advisories = coverage.status === 'observed' ? relevantAlerts(alerts, component) : (previous?.advisories ?? [])
    const status = componentStatus({ component, pin, latest: effectiveLatest, failed: Boolean(failure), advisories })
    const state = stateEntry(previous, effectiveLatest, pin, advisories, coverage, status, now, Boolean(latest))
    nextComponents[component.id] = state
    reportComponents.push({
      id: component.id, name: component.name, integration: component.integration,
      pin, evidence, latest: effectiveLatest, source: component.source,
      status, recommendation: component.recommendation, compatibilityCheck: component.compatibilityCheck,
      patchInventory: component.patchInventory ?? null, advisories,
      advisoryCoverage: coverage,
      fetch: failure ? { status: latest ? 'observed' : 'stale', reason: failure } : { status: component.source?.kind === 'unknown' ? 'unknown' : 'observed' },
      change: state.change
    })
  }
  const required = reportComponents.filter(component => component.source?.kind !== 'unknown')
  const allSucceeded = !advisoryError && required.every(component => component.fetch.status === 'observed' && component.pin)
  const advisoryCoverageStatus = advisoryError || offline
    ? 'unknown'
    : (reportComponents.every(component => component.advisoryCoverage.status === 'observed') ? 'observed' : 'partial-or-unknown')
  const nextState = {
    schemaVersion: 1,
    lastObservationAt: now,
    ...(allSucceeded ? { lastSuccessAt: now } : { lastSuccessAt: previousState.lastSuccessAt ?? null }),
    components: nextComponents
  }
  return {
    schemaVersion: 1, generatedAt: now, repository: origin ?? 'unknown', inventory: inventory.description ?? null,
    coverage: { status: allSucceeded && !advisoryError ? 'current-observation' : 'stale-or-unknown', lastSuccessAt: nextState.lastSuccessAt, advisoryCoverage: advisoryCoverageStatus },
    components: reportComponents, state: nextState
  }
}

export async function loadState(path) {
  try { return await readJson(path) } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, components: {} }; throw error }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

function markdownEscape(value) { return String(value ?? 'unknown').replaceAll('|', '\\|').replaceAll('\n', ' ') }

export function renderMarkdown(report) {
  const lines = [
    '# Atum upstream watch', '',
    `Observed: ${report.generatedAt}`,
    `Repository: ${report.repository}`,
    `Coverage: ${report.coverage.status}; last successful full observation: ${report.coverage.lastSuccessAt ?? 'never'}.`, '',
    '| Component | Pin evidence | Latest source | Status | Change |',
    '| --- | --- | --- | --- | --- |'
  ]
  for (const component of report.components) {
    const pin = component.pin?.map(item => `${item.label}: ${item.value}`).join('<br>') ?? 'unknown'
    const latest = component.latest ? `[${component.latest.version}](${component.latest.url})` : 'unknown'
    lines.push(`| ${markdownEscape(component.name)} | ${markdownEscape(pin)} | ${latest} | ${component.status} | ${component.change} |`)
  }
  lines.push('', '## Required review')
  for (const component of report.components) {
    lines.push(`- **${component.name}** — ${component.recommendation} Smallest check: ${component.compatibilityCheck}`)
    if (component.fetch.status !== 'observed') lines.push(`  Discovery is ${component.fetch.status}: ${component.fetch.reason}. Retained prior release data, if any, is not a fresh success.`)
    if (component.advisoryCoverage.status === 'unknown') {
      lines.push(`  GitHub advisory coverage is unknown: ${component.advisoryCoverage.reason}.${component.advisoryCoverage.freshness === 'retained-unknown' ? ' Previously observed advisory IDs are retained, but their freshness is unknown.' : ''}`)
    }
    for (const advisory of component.advisories) lines.push(`  Open advisory requiring review: ${advisory.url ? `[${advisory.id}](${advisory.url})` : advisory.id} — ${advisory.summary}.`)
  }
  lines.push('', 'A version difference, GitHub release, or advisory signal does not by itself prove vulnerability, compatibility, or that an upgrade is safe.')
  return `${lines.join('\n')}\n`
}

export function resolvePath(repoRoot, value) { return isAbsolute(value) ? value : join(repoRoot, value) }
