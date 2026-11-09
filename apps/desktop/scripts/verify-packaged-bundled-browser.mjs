#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

import BROWSER_RUNTIME from '../browser-runtime.json' with { type: 'json' }
import PACKAGE_JSON from '../package.json' with { type: 'json' }
import { isMain } from './utils.mjs'

const desktopRoot = resolve(import.meta.dirname, '..')

function validateProofUrl(value) {
  let url

  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error('ATUM_BROWSER_PROOF_URL must be a credential-free HTTPS URL owned by the acceptance fixture')
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('ATUM_BROWSER_PROOF_URL must be a credential-free HTTPS URL owned by the acceptance fixture')
  }

  return url.toString()
}

function packagedBrowserLayout({ root = desktopRoot, arch = process.arch } = {}) {
  const productName = PACKAGE_JSON.build?.productName || PACKAGE_JSON.productName
  const appRoot = join(root, 'release', `mac-${arch}`, `${productName}.app`)
  const runtimeRoot = join(appRoot, 'Contents', 'Resources', 'runtime')
  const browserRoot = join(runtimeRoot, 'browser')

  return {
    appRoot,
    runtimeRoot,
    manifest: join(runtimeRoot, 'runtime-manifest.json'),
    python: join(runtimeRoot, 'python', 'bin', 'python3.14'),
    source: join(runtimeRoot, 'hermes-agent'),
    nodeBin: join(browserRoot, 'node', 'bin'),
    browserBin: join(browserRoot, 'bin'),
    agentBrowser: join(browserRoot, 'bin', 'agent-browser'),
    chromium: join(browserRoot, 'chromium', BROWSER_RUNTIME.chromium.root, BROWSER_RUNTIME.chromium.executable)
  }
}

function buildIsolatedBrowserProofEnv(layout, sandbox) {
  const hermesHome = join(sandbox, 'hermes-home')

  return {
    HOME: sandbox,
    HERMES_HOME: hermesHome,
    PATH: [layout.browserBin, layout.nodeBin, '/usr/bin', '/bin'].join(delimiter),
    PYTHONPATH: layout.source,
    PYTHONDONTWRITEBYTECODE: '1',
    AGENT_BROWSER_EXECUTABLE_PATH: layout.chromium,
    AGENT_BROWSER_HOME: join(hermesHome, 'desktop-runtime', 'agent-browser'),
    PLAYWRIGHT_BROWSERS_PATH: join(hermesHome, 'desktop-runtime', 'browser-cache')
  }
}

function validateProofEvidence(evidence, proofUrl) {
  const requested = new URL(proofUrl)
  const navigated = new URL(String(evidence?.result?.url || ''))

  if (evidence?.browser_navigate_published !== true || !evidence?.result?.title) {
    throw new Error('packaged browser proof returned incomplete browser_navigate evidence')
  }
  if (navigated.protocol !== 'https:' || navigated.origin !== requested.origin) {
    throw new Error('packaged browser proof left the controlled direct-navigation origin')
  }

  return evidence
}

function verifyPackagedBundledBrowser({
  proofUrl = process.env.ATUM_BROWSER_PROOF_URL,
  layout = packagedBrowserLayout(),
  spawn = spawnSync
} = {}) {
  if (process.platform !== 'darwin') throw new Error('packaged bundled-browser verification requires macOS')

  const url = validateProofUrl(proofUrl)
  for (const required of [layout.manifest, layout.python, layout.source, layout.agentBrowser, layout.chromium]) {
    if (!existsSync(required)) throw new Error(`packaged browser proof is missing required artifact: ${required}`)
  }

  const manifest = JSON.parse(readFileSync(layout.manifest, 'utf8'))
  if (
    manifest?.schemaVersion !== 3 ||
    manifest?.browser?.agentBrowser?.version !== BROWSER_RUNTIME.agentBrowser.version ||
    manifest?.browser?.chromium?.revision !== BROWSER_RUNTIME.chromium.revision
  ) {
    throw new Error('packaged browser proof rejected mismatched runtime identity')
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'atum-bundled-browser-proof-'))
  const script = [
    'import json, sys',
    'from model_tools import get_tool_definitions',
    'from tools.browser_tool import browser_navigate, cleanup_all_browsers',
    "definitions = get_tool_definitions(enabled_toolsets=['browser'], quiet_mode=True, skip_tool_search_assembly=True)",
    "names = {item.get('function', {}).get('name') for item in definitions}",
    "assert 'browser_navigate' in names, sorted(names)",
    'try:',
    "    result = json.loads(browser_navigate(sys.argv[1], task_id='atum-packaged-browser-proof'))",
    "    assert result.get('success') is True, result",
    "    assert str(result.get('url', '')).startswith('https://'), result",
    "    assert result.get('title'), result",
    "    print(json.dumps({'browser_navigate_published': True, 'result': result}, sort_keys=True))",
    'finally:',
    '    cleanup_all_browsers()'
  ].join('\n')
  const result = spawn(layout.python, ['-B', '-c', script, url], {
    cwd: sandbox,
    encoding: 'utf8',
    env: buildIsolatedBrowserProofEnv(layout, sandbox),
    timeout: 90_000
  })

  if (result.error || result.status !== 0) {
    throw new Error(
      `packaged browser proof failed${result.error ? `: ${result.error.message}` : ` with exit ${result.status}`}\n${[
        result.stdout,
        result.stderr
      ]
        .filter(Boolean)
        .join('\n')}`
    )
  }

  const output = String(result.stdout || '')
    .trim()
    .split('\n')
    .at(-1)
  const evidence = validateProofEvidence(JSON.parse(output), url)
  console.log(`ATUM_BUNDLED_BROWSER_OK app=${layout.appRoot} url=${evidence.result.url} title=${evidence.result.title}`)

  return evidence
}

export {
  buildIsolatedBrowserProofEnv,
  packagedBrowserLayout,
  validateProofEvidence,
  validateProofUrl,
  verifyPackagedBundledBrowser
}

if (isMain(import.meta.url)) verifyPackagedBundledBrowser()
