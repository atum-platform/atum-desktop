import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'

import type { WorkDeliverableStatus } from '../work/sidecar/deliverable-contract'

import { validMacDeliverablePath } from './drive-deliverables-source'
import { executeNativeDriveImport, type NativeDriveImportInput, type NativeWorkDriveTarget, type NativeWorkPlacement, type WorkDesignRenderer } from './drive-import-native'

const mainInstance = randomUUID()
const maxPreviewBytes = 8 * 1024 * 1024

/** Explicit native skill result. All paths are relative to the host-owned run output directory. */
export interface WorkDeliverableResult {
  path: string
  format: 'docx' | 'html' | 'svg'
  preview: null
}

export function parseWorkDeliverableResult(value: unknown): WorkDeliverableResult | undefined {
  if (!value || typeof value !== 'object') {return undefined}
  const { path: relativePath, format, preview } = value as Partial<WorkDeliverableResult>

  if ((format === 'docx' || format === 'html' || format === 'svg') && preview === null &&
      typeof relativePath === 'string' && validMacDeliverablePath(relativePath) &&
      relativePath.toLowerCase().endsWith('.' + format)) {
    return { path: relativePath, format, preview }
  }
}

/** Main-only scope captured at run admission. Persist with the owning run for restart. */
export interface WorkDeliverableScope {
  artifactId: string
  mainInstance: string
  target: NativeWorkDriveTarget
  folder: string[]
  folderIdentity: number[]
  outputRoot: string
  outputIdentity: number[]
}

interface WorkDeliverableDrive {
  workspace(agentPrincipal: string): Promise<string | null>
  target(): NativeWorkDriveTarget | undefined
  remaining(): number | undefined
  manifestFor(paths: readonly string[]): Promise<{
    root: string
    files: Map<string, { etag?: string; size?: number; resource: { storage: string; space: string; opaque: string } } | null>
  } | null>
  open(relativePath: string, identity: { dev: number; ino: number }): Promise<void>
}

function directoryIdentity(folder: string): number[] {
  const stat = lstatSync(folder)

  if (!stat.isDirectory() || realpathSync(folder) !== folder) {throw new Error('work_deliverable_directory_invalid')}

  return [stat.dev, stat.ino]
}

function sameBinding(a: NativeWorkDriveTarget, b: NativeWorkDriveTarget): boolean {
  return a.root === b.root && a.dev === b.dev && a.ino === b.ino && a.bindingKey === b.bindingKey
}

function sameLiveTarget(a: NativeWorkDriveTarget | undefined, b: NativeWorkDriveTarget): boolean {
  return Boolean(a && a.ownerKey === b.ownerKey && sameBinding(a, b))
}

async function verifiedPreview(file: string, facts: NativeWorkPlacement) {
  if (facts.size <= 0 || facts.size > maxPreviewBytes) {return undefined}
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)

  try {
    const stat = await handle.stat()

    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== facts.dev || stat.ino !== facts.ino || stat.size !== facts.size) {
      return undefined
    }

    const bytes = Buffer.alloc(facts.size)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)

    return bytesRead === bytes.length && createHash('sha256').update(bytes).digest('hex') === facts.sha256 ? bytes : undefined
  } finally {
    await handle.close()
  }
}

/** Main-only receiver. The native Work host is responsible for authenticating and settling the run. */
export class WorkDeliverables {
  constructor(
    private readonly home: string,
    private readonly python: string,
    private readonly drive: WorkDeliverableDrive,
    private readonly renderDesign?: WorkDesignRenderer,
    private readonly thumbnail?: (bytes: Buffer) => string | undefined
  ) {}

  async pin(artifactId: string, agentPrincipal: string, outputRoot: string): Promise<WorkDeliverableScope | undefined> {
    const target = this.drive.target()

    if (!target) {return undefined}

    const enrolledWorkspace = await this.drive.workspace(agentPrincipal)

    if (!sameLiveTarget(this.drive.target(), target)) {return undefined}
    const workspace = enrolledWorkspace && /^\/Agents\/([^/]+)$/u.exec(enrolledWorkspace)

    if (!workspace || !validMacDeliverablePath(`Agents/${workspace[1]}/deliverables`)) {
      throw new Error('work_deliverable_workspace_invalid')
    }

    const folder = ['Agents', workspace[1], 'deliverables']

    if (!path.isAbsolute(outputRoot) || path.normalize(outputRoot) !== outputRoot ||
        outputRoot === target.root || outputRoot.startsWith(target.root + path.sep)) {
      throw new Error('work_deliverable_directory_invalid')
    }

    return {
      artifactId, mainInstance, target, folder, folderIdentity: directoryIdentity(path.join(target.root, ...folder)),
      outputRoot, outputIdentity: directoryIdentity(outputRoot)
    }
  }

  async receive(scope: WorkDeliverableScope, result: WorkDeliverableResult, signal?: AbortSignal, admitted?: () => boolean): Promise<WorkDeliverableStatus> {
    return (await this.check(scope, result, 'work-place', signal, admitted)).status
  }

  async status(scope: WorkDeliverableScope, result: WorkDeliverableResult, signal?: AbortSignal): Promise<WorkDeliverableStatus> {
    const checked = await this.check(scope, result, 'work-probe', signal)
    const { status, previewReceipt } = checked

    if (status.state !== 'saved' || !previewReceipt || !this.thumbnail) {return status}
    const { target, relativePath, facts } = previewReceipt

    if (signal?.aborted || !sameLiveTarget(this.drive.target(), target)) {return { state: 'changed' }}
    const bytes = await verifiedPreview(path.join(target.root, relativePath), facts).catch(() => undefined)

    if (signal?.aborted || !sameLiveTarget(this.drive.target(), target)) {return { state: 'changed' }}
    const previewDataUrl = bytes && this.thumbnail(bytes)

    return previewDataUrl ? { ...status, previewDataUrl } : status
  }

  async open(scope: WorkDeliverableScope, result: WorkDeliverableResult, admitted?: () => boolean, preview = false): Promise<void> {
    const checked = await this.check(scope, result, 'work-probe', undefined, admitted, preview)

    if (!checked.receipt || admitted?.() === false || !sameLiveTarget(this.drive.target(), checked.receipt.target)) {
      throw new Error('work_deliverable_unavailable')
    }

    await this.drive.open(checked.receipt.relativePath, checked.receipt)
  }

  private async check(
    scope: WorkDeliverableScope, result: WorkDeliverableResult, mode: 'work-place' | 'work-probe',
    signal?: AbortSignal, admitted?: () => boolean, preview = false
  ): Promise<{
    status: WorkDeliverableStatus
    receipt?: { relativePath: string; dev: number; ino: number; target: NativeWorkDriveTarget }
    previewReceipt?: { relativePath: string; facts: NativeWorkPlacement; target: NativeWorkDriveTarget }
  }> {
    if (signal?.aborted || admitted?.() === false) {return { status: { state: 'cancelled' } }}

    if (!parseWorkDeliverableResult(result)) {
      return { status: { state: 'invalid' } }
    }

    const target = this.drive.target()

    if (!target) {return { status: { state: 'drive_unavailable' } }}
    const current = () => admitted?.() !== false && sameLiveTarget(this.drive.target(), target)
    const workRecovery = scope.mainInstance !== mainInstance

    if (!sameBinding(target, scope.target) || (!workRecovery && target.ownerKey !== scope.target.ownerKey)) {
      return { status: { state: 'changed' } }
    }

    const input: NativeDriveImportInput = {
      mode, home: this.home, target, workRecovery, remaining: this.drive.remaining(),
      work: {
        id: scope.artifactId, bindingKey: target.bindingKey, folder: scope.folder, folderIdentity: scope.folderIdentity,
        outputRoot: scope.outputRoot, outputIdentity: scope.outputIdentity, path: result.path.split('/'),
        ...(result.format === 'docx' ? {} : { design: result.format })
      }
    }

    const native = await executeNativeDriveImport(this.python, input, signal, current, this.renderDesign)

    if (signal?.aborted) {return { status: { state: 'cancelled' } }}

    if (!current() || native.state === 'changed') {return { status: { state: 'changed' } }}

    if (native.state === 'no_room') {return { status: { state: 'no_room' } }}

    if (native.state === 'refused') {return { status: { state: 'invalid' } }}
    const placed = native.placement

    if (native.state !== 'completed' || !placed) {return { status: { state: 'retry' } }}

    const companion = native.previewPlacement
    if (result.format !== 'docx' && !companion) {return { status: { state: 'retry' } }}
    const placements = companion ? [placed, companion] : [placed]
    const relative = (name: string) => [...scope.folder, name].join('/')
    const manifest = await this.drive.manifestFor(placements.map(file => relative(file.name))).catch(() => null)

    if (!current()) {return { status: { state: 'changed' } }}

    if (signal?.aborted) {return { status: { state: 'cancelled' } }}
    const display = { artifactId: scope.artifactId, name: placed.name, ...(companion && { previewName: companion.name }) }

    if (manifest?.root !== target.root || !placements.every(file => {
      const clean = manifest.files.get(relative(file.name))

      return clean?.etag && clean.size === file.size && clean.resource.storage && clean.resource.space && clean.resource.opaque
    })) {
      return { status: { state: 'syncing', ...display } }
    }

    // A server fact is only evidence for the same local version checked before and after the request.
    const verified = await executeNativeDriveImport(this.python, { ...input, mode: 'work-probe' }, signal, current)

    if (signal?.aborted) {return { status: { state: 'cancelled' } }}

    if (!current() || verified.state === 'changed') {return { status: { state: 'changed' } }}

    if (verified.state !== 'completed' || verified.placement?.sha256 !== placed.sha256 ||
        verified.previewPlacement?.sha256 !== companion?.sha256) {
      return { status: { state: 'retry' } }
    }

    const asset = preview ? companion : placed

    return {
      status: { state: 'saved', ...display },
      receipt: asset && { relativePath: relative(asset.name), dev: asset.dev, ino: asset.ino, target },
      previewReceipt: companion && { relativePath: relative(companion.name), facts: companion, target }
    }
  }
}
