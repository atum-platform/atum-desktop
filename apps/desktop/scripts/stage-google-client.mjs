import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

export const GOOGLE_DESKTOP_CLIENT_ASAR_PATH = 'assets/google-desktop-client.json'
export const GOOGLE_DESKTOP_CLIENT_MAX_BYTES = 16_384

/**
 * Matches the main-process readGoogleClient contract. An installed-app client
 * secret is part of Google's public desktop client configuration, but callers
 * must never include the parsed values in errors or release output.
 */
export function parseGoogleClient(contents) {
  try {
    if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > GOOGLE_DESKTOP_CLIENT_MAX_BYTES) return null
    const client = JSON.parse(contents)?.installed
    if (!client || typeof client.client_id !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/u.test(client.client_id)) return null
    if (client.client_secret !== undefined && typeof client.client_secret !== 'string') return null
    return { clientId: client.client_id, clientSecret: client.client_secret }
  } catch {
    return null
  }
}

export function readGoogleClient(file) {
  try {
    if (statSync(file).size > GOOGLE_DESKTOP_CLIENT_MAX_BYTES) return null
    return parseGoogleClient(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function requireGoogleClient(file) {
  const client = readGoogleClient(file)
  if (!client) {
    throw new Error('Provision the Atum installed-app Google OAuth registration in assets/google-desktop-client.json before release')
  }
  return client
}

/**
 * Development and CI builds may run without a locally provisioned client.
 * Remove a prior staged copy first so an absent source cannot leave a stale
 * registration in a reused output directory.
 */
export function stageGoogleClient({ source, output }) {
  rmSync(output, { force: true })
  if (!existsSync(source)) return false
  requireGoogleClient(source)
  mkdirSync(path.dirname(output), { recursive: true })
  copyFileSync(source, output)
  return true
}
