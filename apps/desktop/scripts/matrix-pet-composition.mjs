import path from 'node:path'

// Preserve user-visible identity, state and recovery behavior across connection changes.
// the presentation pieces it shares with that chat: the composer surface, the message clock and
// the app's icons. None of them reads an account, a room or the network.
const ALLOWED =
  /^(?:matrix-pet\.html$|src\/styles\.css$|src\/matrix\/pet\/(?:overlay-root\.(?:tsx|css)|overlay-copy\.ts|hit-box\.ts|chat-box\.tsx|pet-face\.tsx)$|src\/matrix\/(?:pet-copy|message-time)\.ts$|src\/components\/(?:ui|pet)\/|src\/components\/chat\/composer-dock\.ts$|src\/app\/chat\/composer\/composer-surface\.tsx$|src\/lib\/(?:utils\.ts|icons\.ts|phosphor-icon\.tsx)$|src\/i18n(?:[./]|$)|shared\/pet(?:\.ts$|-engine\/)|shared\/pet-chat\/atum-pet-chat\.ts$|shared\/matrix-pet-overlay\.ts$|@atum\/kit\/(?:src\/icon\.tsx|dist\/phosphor-icons\.json)$)/u
/** The Atum Kit workspace package lives beside the app, wherever the install links it from. Only
 * its icon module is presentation the overlay may take; it is recorded under the package name. */
const KIT_ICON = /\/packages\/atum-kit\/(src\/icon\.tsx|dist\/phosphor-icons\.json)$/u
const FORBIDDEN_PACKAGE =
  /(?:^|[/@])(?:electron|matrix-js-sdk|matrix-sdk-crypto-wasm|sandbox-runtime)(?:[/@]|$)|json-rpc-gateway/iu

export function assertMatrixPetPresentationPaths(modules) {
  if (!Array.isArray(modules) || modules.some(file => typeof file !== 'string' || !ALLOWED.test(file))) {
    throw new Error('matrix_pet_composition_denied:manifest')
  }
}

/** Evidence comes from the built graph; import aliases cannot bypass the boundary. */
export function matrixPetRendererModules(ids, root) {
  const local = []
  for (const raw of ids) {
    const id = raw.split('?')[0].replaceAll('\\', '/')
    if (FORBIDDEN_PACKAGE.test(id)) {
      throw new Error(`matrix_pet_composition_denied:${id}`)
    }
    if (id.startsWith('\0') || id.includes('/node_modules/')) {
      continue
    }
    const kit = KIT_ICON.exec(id)
    if (kit) {
      local.push(`@atum/kit/${kit[1]}`)
      continue
    }
    if (!id.startsWith(`${root.replaceAll('\\', '/')}/`)) {
      throw new Error(`matrix_pet_composition_denied:${id}`)
    }
    const relative = path.relative(root, id).replaceAll('\\', '/')
    if (relative.startsWith('node_modules/')) {
      continue
    }
    if (!ALLOWED.test(relative)) {
      throw new Error(`matrix_pet_composition_denied:${relative}`)
    }
    local.push(relative)
  }
  return [...new Set(local)].sort()
}

export function matrixPetCompositionEvidence(root) {
  return {
    name: 'matrix-pet-composition-evidence',
    generateBundle(_options, output) {
      const ids = Object.values(output)
        .filter(file => file.type === 'chunk')
        .flatMap(file => Object.keys(file.modules))
      const modules = matrixPetRendererModules(ids, root)
      this.emitFile({ type: 'asset', fileName: 'matrix-pet-modules.json', source: JSON.stringify(modules, null, 2) })
    }
  }
}
