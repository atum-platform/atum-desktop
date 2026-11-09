#!/usr/bin/env node
// Runs the real consumer-browser controller against real Chromium (the repo's pinned Electron) twice:
// without the pinned-address proxy (the behaviour before 2026-11-07) and with it. Offline; loopback only.
//   node scripts/verify-consumer-browser-pinning.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const work = mkdtempSync(path.join(os.tmpdir(), 'atum-pinning-'))
const bundle = path.join(work, 'main.cjs')

await build({
  entryPoints: [path.join(root, 'scripts/verify-consumer-browser-pinning.main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: bundle,
  external: ['electron'],
  logLevel: 'warning'
})

function run(mode) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, [bundle, `--mode=${mode}`, `--user-data-dir=${path.join(work, mode)}`], { env, encoding: 'utf8', timeout: 90_000 })
  const line = result.stdout.split('\n').find(value => value.startsWith('RESULT '))

  if (!line) {
    throw new Error(`${mode}: no result\n${result.stdout}\n${result.stderr}`)
  }

  return JSON.parse(line.slice('RESULT '.length))
}

let failed = false

function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`)
  failed ||= !ok
}

try {
  const unpinned = run('unpinned')
  console.log('unpinned', JSON.stringify(unpinned))
  check('premise: without the pin, Chromium reaches the loopback marker the policy never approved', unpinned.fetch === 'LOOPBACK-MARKER' && unpinned.markerHits > 0, unpinned)

  const pinned = run('pinned')
  console.log('pinned  ', JSON.stringify(pinned))
  check('with the pin, no request reaches loopback', pinned.markerHits === 0 && pinned.fetch === undefined, pinned)
  check('with the pin, only the vetted public address was dialled', pinned.dialed?.length > 0 && pinned.dialed.every(entry => entry.addresses.length === 1 && entry.addresses[0] === '93.184.216.34' && entry.hostname === 'rebind.test'), pinned)

  const legit = run('legit')
  console.log('legit   ', JSON.stringify(legit))
  check('with the pin, a public site still loads, fetches and opens a WebSocket (http forward + CONNECT)', legit.load === 'loaded' && legit.pageTitle === 'attacker page' && legit.fetch === 'LOOPBACK-MARKER' && legit.websocket === 'WS-HELLO' && legit.dialed?.length > 0 && legit.dialed.every(entry => entry.addresses.join() === '93.184.216.34'), legit)
} finally {
  rmSync(work, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
