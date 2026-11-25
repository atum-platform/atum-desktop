#!/usr/bin/env node
// Writes Work's T3 environment theme (`electron/work/sidecar/atum.json`): the Atum Kit's palette as a T3
// theme file, `packages/atum-kit/dist/atum-t3-theme.json`, byte for byte. The desktop reads the same
// palette as T3's --app-theme-* variables in the Kit stylesheet, so Work and the desktop share one
// colour source (owner 2026-11-24, option B). The theme carries colours only: Work is stock T3 in
// Atum's colours, with no CSS block.
//
//   node scripts/build-work-theme.mjs          write the theme
//   node scripts/build-work-theme.mjs --check  fail when the committed theme is stale
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const desktop = new URL('../', import.meta.url)
const palette = new URL('../../packages/atum-kit/dist/atum-t3-theme.json', desktop)
const output = fileURLToPath(new URL('electron/work/sidecar/atum.json', desktop))

export function buildWorkTheme() {
  return readFileSync(palette, 'utf8')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const next = buildWorkTheme()

  if (process.argv.includes('--check')) {
    if (readFileSync(output, 'utf8') !== next) {
      console.error('electron/work/sidecar/atum.json is stale: run node scripts/build-work-theme.mjs')
      process.exit(1)
    }
  } else {
    writeFileSync(output, next)
  }
}
