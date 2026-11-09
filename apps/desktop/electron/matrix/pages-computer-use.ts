import type { MatrixComputerUseSnapshot } from '../../shared/matrix-computer-use'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const STATUS_PATH = '/api/tools/computer-use/status'
const STATUS_REQUEST = `${STATUS_PATH}?profile=default`

function denied(): never {
  throw new Error('matrix_pages_request_forbidden')
}

function unavailable(): never {
  throw new Error('matrix_pages_agent_unavailable')
}

function invalid(): never {
  throw new Error('matrix_computer_use_response_invalid')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nullableBoolean(value: unknown, present: boolean): boolean | null {
  if (!present || value == null) {
    return null
  }

  if (typeof value !== 'boolean') {
    return invalid()
  }

  return value
}

/** This scope owns one exact passive status route, never its query variants. */
export function isMatrixComputerUseRequest(path: unknown): path is '/api/tools/computer-use/status' {
  return path === STATUS_PATH
}

function exactStatusRequest(value: unknown): void {
  if (
    !record(value) ||
    Object.keys(value).some(key => key !== 'path' && key !== 'method') ||
    Object.hasOwn(value, 'body') ||
    value.path !== STATUS_PATH ||
    (value.method !== undefined && value.method !== 'GET')
  ) {
    return denied()
  }
}

function snapshot(value: unknown): MatrixComputerUseSnapshot {
  if (!record(value) || typeof value.platform !== 'string' || typeof value.installed !== 'boolean') {
    return invalid()
  }

  // Validate every boolean-shaped field whenever an upstream payload names it,
  // even where the field has no meaning on the selected platform.
  const ready = nullableBoolean(value.ready, Object.hasOwn(value, 'ready'))
  const accessibility = nullableBoolean(value.accessibility, Object.hasOwn(value, 'accessibility'))
  const screenRecording = nullableBoolean(value.screen_recording, Object.hasOwn(value, 'screen_recording'))

  const screenRecordingCapturable = nullableBoolean(
    value.screen_recording_capturable,
    Object.hasOwn(value, 'screen_recording_capturable')
  )

  const platform = value.platform === 'darwin' || value.platform === 'win32' || value.platform === 'linux'
    ? value.platform
    : 'unsupported'

  // A driver cannot be ready until it exists, and unsupported systems have no
  // driver contract. Ignore forged status and TCC data in both cases.
  if (!value.installed || platform === 'unsupported') {
    return {
      platform,
      installed: platform === 'unsupported' ? false : value.installed,
      ready: null,
      accessibility: null,
      screenRecording: null,
      screenRecordingCapturable: null
    }
  }

  // The upstream status records this when a probe itself failed. Never project
  // an earlier or forged success alongside that failure.
  if (value.error !== undefined && value.error !== null) {
    return {
      platform,
      installed: true,
      ready: null,
      accessibility: null,
      screenRecording: null,
      screenRecordingCapturable: null
    }
  }

  if (platform !== 'darwin') {
    return {
      platform,
      installed: true,
      ready,
      accessibility: null,
      screenRecording: null,
      screenRecordingCapturable: null
    }
  }

  return {
    platform,
    installed: true,
    ready: accessibility === false || screenRecording === false
      ? false
      : accessibility === true && screenRecording === true
        ? true
        : null,
    accessibility,
    screenRecording,
    screenRecordingCapturable
  }
}

export interface MatrixPagesComputerUseScopeDeps {
  /** Account/executor/scope generation guard supplied by the composition root. */
  isCurrent(): boolean
  /** The selected agent's already-scoped pages transport. */
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
}

/** Passive selected-agent CuaDriver status. This has no install, grant, or
 * action-status authority. */
export class MatrixPagesComputerUseScope {
  constructor(private readonly deps: MatrixPagesComputerUseScopeDeps) {}

  private assertCurrent(): void {
    if (!this.deps.isCurrent()) {
      unavailable()
    }
  }

  async request(value: MatrixPagesRequest): Promise<MatrixComputerUseSnapshot> {
    exactStatusRequest(value)
    this.assertCurrent()

    let response: unknown

    try {
      response = await this.deps.forward({ path: STATUS_REQUEST, method: 'GET' })
    } catch {
      return unavailable()
    }

    this.assertCurrent()

    return snapshot(response)
  }
}

/** Convenience factory for composition roots that prefer functions over `new`. */
export function createMatrixPagesComputerUseScope(
  deps: MatrixPagesComputerUseScopeDeps
): MatrixPagesComputerUseScope {
  return new MatrixPagesComputerUseScope(deps)
}
