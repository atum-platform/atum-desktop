import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

import type { NativeAppEntry } from '../shared/skills-launcher'

import type { WordBounds } from './word-companion-mac'

export interface NativeWindowSnapshot {
  id: number
  title: string
  bounds: WordBounds
  fullscreen: boolean
  minimized: boolean
}

export interface NativeWindowTarget { path: string; entry: { bundleId: string } }

interface NativeDocumentIdentity {
  appPath: string
  bundleId: 'com.microsoft.Excel' | 'com.microsoft.Powerpoint'
  processId: number
  windowId: number
  documentPath?: string
}

interface NativeDocumentWindow extends NativeDocumentIdentity {
  title: string
}

/** Kept in Electron only; its file identity is never returned by the picker list. */
export interface NativeOpenDocumentWindowCandidate {
  app: NativeAppEntry
  title: string
  hasSavedFile: boolean
  identity: NativeDocumentIdentity
}

interface NativeHelperResponse {
  windows?: NativeWindowSnapshot[]
  documents?: NativeDocumentWindow[]
  documentPath?: string
  automationAllowed?: boolean
  icons?: Record<string, string>
  names?: Record<string, string>
}

function execute(command: string, request: unknown): Promise<NativeHelperResponse> {
  return new Promise((resolve, reject) => {
      const child = spawn(command, [], { stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, LANG: 'en_US.UTF-8' } })

      let output = ''
      let settled = false

      const fail = (code: string) => {
        if (settled) {return}
        settled = true
        clearTimeout(timer)
        child.kill()
        reject(new Error(code))
      }

      const timer = setTimeout(() => fail('unavailable'), 8000)
      child.on('error', () => fail('unavailable'))
      child.stdin.on('error', () => { /* Exit/error owns settlement. */ })
      child.stdout.on('data', chunk => {
        output += chunk.toString()

        if (output.length > 4 * 1024 * 1024) {fail('unavailable')}
      })
      child.on('close', code => {
        if (settled) {return}
        clearTimeout(timer)

        try {
          const result = JSON.parse(output)

          if (code !== 0 || result.error) {throw new Error(['permission', 'fullscreen', 'layout-failed'].includes(result.error) ? result.error : 'unavailable')}
          settled = true
          resolve(result)
        } catch (error) {fail(error instanceof Error ? error.message : 'unavailable')}
      })
      child.stdin.end(JSON.stringify(request))
    })

}

// Launcher tiles draw artwork at 56 CSS px; the helper renders 112 px PNGs
// (about 15–30 KB each), so a batch stays well under the 4 MB output cap.
const PRESENTATION_BATCH = 32
const PRESENTATION_CONCURRENCY = 4

/** Finder artwork and localized display names for app bundles, from the native helper. */
export async function nativeAppPresentation(command: string, paths: string[]): Promise<{ icons: Record<string, string>; names: Record<string, string> }> {
  const icons: Record<string, string> = {}
  const names: Record<string, string> = {}

  const batches: string[][] = []

  for (let offset = 0; offset < paths.length; offset += PRESENTATION_BATCH) {
    batches.push(paths.slice(offset, offset + PRESENTATION_BATCH))
  }

  // Rendering is CPU-bound per process: a few helpers side by side keep the
  // first open of a full /Applications near a second instead of several.
  for (let offset = 0; offset < batches.length; offset += PRESENTATION_CONCURRENCY) {
    const results = await Promise.all(batches.slice(offset, offset + PRESENTATION_CONCURRENCY)
      .map(batch => execute(command, { operation: 'icons', paths: batch })))

    for (const result of results) {
      Object.assign(icons, result.icons)
      Object.assign(names, result.names)
    }
  }

  return { icons, names }
}

export function createNativeAppWindows(command: string) {
  const request = (target: NativeWindowTarget, operation: string, window?: NativeWindowSnapshot, bounds?: WordBounds) =>
    execute(command, { operation, appPath: target.path, bundleId: target.entry.bundleId, windowId: window?.id, bounds })

  return {
    list: async (target: NativeWindowTarget) => (await request(target, 'windows')).windows ?? [],
    arrange: async (target: NativeWindowTarget, window: NativeWindowSnapshot, bounds: WordBounds) => {await request(target, 'arrange', window, bounds)},
    restore: async (target: NativeWindowTarget, window: NativeWindowSnapshot) => {await request(target, 'restore', window, window.bounds)}
  }
}

function nativeAppId(bundlePath: string): string {
  // Keep document candidates compatible with the launcher's app ids without
  // scanning every installed application just to inspect two running apps.
  return `native-app:${createHash('sha256').update(bundlePath).digest('hex').slice(0, 32)}`
}

function fallbackName(bundlePath: string): string {
  return path.basename(bundlePath).replace(/\.app$/iu, '') || 'Microsoft Office'
}

/**
 * Read-only candidates from already-running Excel and PowerPoint. The native
 * helper proves a saved path through AXDocument; a window title is presentation
 * metadata only and never a source of file identity.
 */
export function createNativeOpenDocumentWindows(command: string) {
  return {
    async list(): Promise<NativeOpenDocumentWindowCandidate[]> {
      const documents = (await execute(command, { operation: 'document-windows' })).documents ?? []
      const paths = [...new Set(documents.map(document => document.appPath))]
      let presentation: { icons: Record<string, string>; names: Record<string, string> } = { icons: {}, names: {} }

      try {presentation = await nativeAppPresentation(command, paths)} catch { /* A document candidate remains useful without artwork. */ }

      return documents.map(document => ({
        app: {
          id: nativeAppId(document.appPath),
          name: presentation.names[document.appPath]?.replace(/\.app$/iu, '').trim() || fallbackName(document.appPath),
          bundleId: document.bundleId,
          ...(presentation.icons[document.appPath] ? { icon: presentation.icons[document.appPath] } : {})
        },
        title: document.title,
        hasSavedFile: Boolean(document.documentPath),
        identity: {
          appPath: document.appPath,
          bundleId: document.bundleId,
          processId: document.processId,
          windowId: document.windowId,
          ...(document.documentPath ? { documentPath: document.documentPath } : {})
        }
      }))
    },
    async resolve(candidate: NativeOpenDocumentWindowCandidate): Promise<string | null> {
      if (!candidate.hasSavedFile || !candidate.identity.documentPath) {return null}

      try {
        return (await execute(command, { operation: 'resolve-document-window', ...candidate.identity })).documentPath ?? null
      } catch {
        // The candidate is deliberately short-lived. A closed, Save As, or
        // swapped window falls back to the user's ordinary file chooser.
        return null
      }
    }
  }
}

/** Native no-prompt Apple Events preflight used only by the Word adapter. */
export async function nativeWordAutomationAllowed(command: string): Promise<boolean> {
  try {return (await execute(command, { operation: 'word-automation-permission' })).automationAllowed === true} catch {return false}
}
