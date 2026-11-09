import path from 'node:path'

/**
 * Where the pets that ship with the app live, for the process that needs a
 * real directory: the Python backend installs from it by copying files.
 *
 * Inside app.asar the directory "exists" for Electron (it patches fs) and for
 * nobody else, so packaging unpacks assets/pets (package.json `asarUnpack`)
 * and the unpacked copy is preferred. In a dev checkout the two candidates
 * are the same path.
 */
export function bundledPetsCandidates(appRoot: string): string[] {
  return [...new Set([path.join(unpackedRoot(appRoot), 'assets', 'pets'), path.join(appRoot, 'assets', 'pets')])]
}

/** `…/app.asar` → `…/app.asar.unpacked`, on the archive itself — the last such
 *  segment — not on a parent directory that happens to carry the name. */
export function unpackedRoot(appRoot: string): string {
  const segments = appRoot.split(/([\\/])/)
  const last = segments.lastIndexOf('app.asar')

  if (last === -1) {
    return appRoot
  }

  segments[last] = 'app.asar.unpacked'

  return segments.join('')
}

export function resolveBundledPetsDir(appRoot: string, directoryExists: (candidate: string) => boolean): string | undefined {
  return bundledPetsCandidates(appRoot).find(candidate => directoryExists(candidate))
}
