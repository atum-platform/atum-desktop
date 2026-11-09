import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReport, createLiveFetchers, loadState, resolveLocators, saveState } from './core.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'upstream-watch-'))
  await mkdir(join(root, 'apps/desktop'), { recursive: true })
  await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ dependencies: { tracked: '1.0.0' } }))
  return root
}

const npmComponent = {
  id: 'tracked', name: 'Tracked package', integration: 'fixture',
  source: { kind: 'npm', package: 'tracked', url: 'https://example.test/tracked' },
  advisory: { kind: 'dependabot', packages: ['tracked'] },
  locators: [{ kind: 'package', path: 'apps/desktop/package.json', section: 'dependencies', name: 'tracked' }],
  recommendation: 'Review it.', compatibilityCheck: 'Run a focused check.'
}

function fetchers({ version = '1.1.0', fail = false, alerts = [], advisoryFail = false } = {}) {
  return {
    npm: async () => { if (fail) throw new Error('network unavailable'); return { version, url: `https://example.test/${version}` } },
    release: async () => ({ version, url: `https://example.test/${version}` }),
    advisories: async () => { if (advisoryFail) throw new Error('advisory access unavailable'); return alerts }
  }
}

test('reads a platform compose image only from an explicitly supplied repository', async () => {
  const root = await fixture()
  const platform = await mkdtemp(join(tmpdir(), 'upstream-platform-'))
  await mkdir(join(platform, 'deploy/chat'), { recursive: true })
  await writeFile(join(platform, 'deploy/chat/compose.yaml'), 'services:\n  synapse:\n    image: ghcr.io/element-hq/synapse:v1.99.0\n  mas:\n    image: ghcr.io/element-hq/matrix-authentication-service:v1.2.3\n')
  const component = { locators: [{ kind: 'compose-image', repository: 'atum-platform', path: 'deploy/chat/compose.yaml', service: 'synapse' }] }
  assert.equal((await resolveLocators(component, root))[0].status, 'unknown')
  const evidence = await resolveLocators(component, root, { 'atum-platform': platform })
  assert.equal(evidence[0].value, 'ghcr.io/element-hq/synapse:v1.99.0')
})

test('deduplicates a known candidate and records a changed candidate', async () => {
  const root = await fixture()
  const first = await buildReport({ repoRoot: root, inventory: { components: [npmComponent] }, fetchers: fetchers(), repository: 'atum-platform/atum-app', now: '2026-09-28T01:00:00.000Z' })
  assert.equal(first.components[0].change, 'new')
  const second = await buildReport({ repoRoot: root, inventory: { components: [npmComponent] }, previousState: first.state, fetchers: fetchers(), repository: 'atum-platform/atum-app', now: '2026-09-28T02:00:00.000Z' })
  assert.equal(second.components[0].change, 'unchanged')
  const changed = await buildReport({ repoRoot: root, inventory: { components: [npmComponent] }, previousState: second.state, fetchers: fetchers({ version: '1.2.0' }), repository: 'atum-platform/atum-app', now: '2026-09-28T03:00:00.000Z' })
  assert.equal(changed.components[0].change, 'changed')
})

test('migrates candidate-only state without re-notifying an unchanged observation', async () => {
  const root = await fixture()
  const previousState = {
    schemaVersion: 1,
    components: {
      tracked: { candidateKey: '1.1.0\u0000https://example.test/1.1.0', lastStatus: 'review-release' }
    }
  }
  const report = await buildReport({ repoRoot: root, inventory: { components: [npmComponent] }, previousState, fetchers: fetchers(), repository: 'atum-platform/atum-app' })
  assert.equal(report.components[0].change, 'unchanged')
  assert.ok(report.state.components.tracked.fingerprint)
})

test('compares a container image tag to a release while retaining digest pin evidence', async () => {
  const root = await fixture()
  const platform = await mkdtemp(join(tmpdir(), 'upstream-platform-'))
  await mkdir(join(platform, 'deploy/chat'), { recursive: true })
  await writeFile(join(platform, 'deploy/chat/compose.yaml'), 'services:\n  synapse:\n    image: docker.io/matrixdotorg/synapse:v1.161.0@sha256:deadbeef\n')
  const component = {
    id: 'synapse', name: 'Synapse', integration: 'fixture', comparison: 'image-tag',
    source: { kind: 'github-release', repository: 'element-hq/synapse' },
    advisory: { kind: 'unsupported', reason: 'container image coverage is unavailable' },
    locators: [{ kind: 'compose-image', repository: 'atum-platform', path: 'deploy/chat/compose.yaml', service: 'synapse' }],
    recommendation: 'Review it.', compatibilityCheck: 'Run a staged migration.'
  }
  const report = await buildReport({
    repoRoot: root, repositories: { 'atum-platform': platform }, inventory: { components: [component] },
    fetchers: { ...fetchers(), release: async () => ({ version: 'v1.161.0', url: 'https://example.test/v1.161.0' }) },
    repository: 'atum-platform/atum-app'
  })
  assert.equal(report.components[0].status, 'current')
  assert.equal(report.components[0].pin[0].value, 'docker.io/matrixdotorg/synapse:v1.161.0@sha256:deadbeef')
  assert.equal(report.components[0].advisoryCoverage.status, 'unknown')
})

test('retains prior useful state and reports stale coverage when discovery fails', async () => {
  const root = await fixture()
  const prior = { schemaVersion: 1, lastSuccessAt: '2026-09-27T00:00:00.000Z', components: { tracked: { latest: { version: '1.1.0', url: 'https://example.test/1.1.0' }, candidateKey: '1.1.0\u0000https://example.test/1.1.0', firstSeenAt: '2026-09-27T00:00:00.000Z' } } }
  const report = await buildReport({ repoRoot: root, inventory: { components: [npmComponent] }, previousState: prior, fetchers: fetchers({ fail: true }), repository: 'atum-platform/atum-app', now: '2026-09-28T04:00:00.000Z' })
  assert.equal(report.components[0].status, 'stale')
  assert.equal(report.components[0].latest.version, '1.1.0')
  assert.equal(report.coverage.lastSuccessAt, '2026-09-27T00:00:00.000Z')
})

test('flags matching Dependabot alerts for review without treating a release gap as proof', async () => {
  const root = await fixture()
  const report = await buildReport({
    repoRoot: root, inventory: { components: [npmComponent] }, repository: 'atum-platform/atum-app', now: '2026-09-28T05:00:00.000Z',
    fetchers: fetchers({ alerts: [{ dependency: { package: { name: 'tracked' } }, security_advisory: { ghsa_id: 'GHSA-test', html_url: 'https://example.test/advisory', summary: 'Needs review' } }] })
  })
  assert.equal(report.components[0].status, 'security-review')
  assert.equal(report.components[0].advisories[0].id, 'GHSA-test')
})

test('deduplicates meaningful observations and retains prior advisory findings after coverage fails', async () => {
  const root = await fixture()
  const alerts = [{ dependency: { package: { name: 'tracked' } }, security_advisory: { ghsa_id: 'GHSA-test', html_url: 'https://example.test/advisory', summary: 'Needs review' } }]
  const first = await buildReport({ repoRoot: root, inventory: { components: [npmComponent] }, fetchers: fetchers({ alerts }), repository: 'atum-platform/atum-app', now: '2026-09-28T01:00:00.000Z' })
  const unchanged = await buildReport({ repoRoot: root, inventory: { components: [npmComponent] }, previousState: first.state, fetchers: fetchers({ alerts }), repository: 'atum-platform/atum-app', now: '2026-09-28T02:00:00.000Z' })
  assert.equal(unchanged.components[0].change, 'unchanged')
  const failedCoverage = await buildReport({ repoRoot: root, inventory: { components: [npmComponent] }, previousState: unchanged.state, fetchers: fetchers({ advisoryFail: true }), repository: 'atum-platform/atum-app', now: '2026-09-28T03:00:00.000Z' })
  assert.equal(failedCoverage.components[0].change, 'changed')
  assert.deepEqual(failedCoverage.components[0].advisories.map(advisory => advisory.id), ['GHSA-test'])
  assert.deepEqual(failedCoverage.components[0].advisoryCoverage, { status: 'unknown', reason: 'advisory access unavailable', freshness: 'retained-unknown' })
  assert.deepEqual(failedCoverage.state.components.tracked.advisories.map(advisory => advisory.id), ['GHSA-test'])
})

test('paginates advisory results and bounds injected GitHub requests', async () => {
  const calls = []
  const live = await createLiveFetchers({
    github: async (path, options) => {
      calls.push({ path, options })
      return options?.paginate ? [[{ id: 1 }], [{ id: 2 }]] : { tag_name: 'v1.0.0', html_url: 'https://example.test/v1.0.0' }
    },
    timeoutMs: 20
  })
  assert.deepEqual(await live.advisories('atum-platform/atum-app'), [{ id: 1 }, { id: 2 }])
  assert.deepEqual(calls[0], { path: 'repos/atum-platform/atum-app/dependabot/alerts?state=open&per_page=100', options: { paginate: true } })
  const stalled = await createLiveFetchers({ github: async () => new Promise(() => {}), timeoutMs: 5 })
  await assert.rejects(stalled.release({ repository: 'example/repo' }), /timed out after 5ms/)
})

test('writes and reloads state atomically enough for a subsequent observation', async () => {
  const root = await fixture()
  const path = join(root, 'state', 'watch.json')
  const state = { schemaVersion: 1, components: { tracked: { candidateKey: 'x' } } }
  await saveState(path, state)
  assert.deepEqual(await loadState(path), state)
})
