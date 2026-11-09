import path from 'node:path'

import { extractFile, listPackage } from '@electron/asar'

function normalizeArchivePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '')
}

export function checkPackagedRendererEntries(indexHtml, archiveEntries) {
  const references = [...String(indexHtml).matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map(match => match[1].split(/[?#]/, 1)[0])
    .filter(reference => reference.startsWith('./assets/') || reference.startsWith('/assets/'))
    .map(reference => `dist/${normalizeArchivePath(reference)}`)

  if (!references.some(reference => reference.endsWith('.js'))) {
    return { ok: false, error: 'dist/index.html has no local JavaScript entry reference' }
  }

  const entries = new Set(archiveEntries.map(normalizeArchivePath))
  const missing = references.filter(reference => !entries.has(reference))

  if (missing.length > 0) {
    return {
      ok: false,
      error: `packaged renderer archive is missing referenced assets: ${missing.join(', ')}`
    }
  }

  return { ok: true }
}

export function assertPackagedRenderer(appRoot) {
  const asarPath = path.join(appRoot, 'Contents', 'Resources', 'app.asar')
  const indexHtml = extractFile(asarPath, 'dist/index.html').toString('utf8')
  const result = checkPackagedRendererEntries(indexHtml, listPackage(asarPath))

  if (!result.ok) {
    throw new Error(`${result.error} (${asarPath})`)
  }

  console.log(`[after-pack] renderer archive references verified: ${asarPath}`)
}

