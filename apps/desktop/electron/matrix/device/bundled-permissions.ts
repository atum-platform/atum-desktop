import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Upstream trycua/cua@70db98d1bc, cli.rs:3294–3457 and
 * platform-macos/src/tools/check_permissions.rs:15–40. Keep the signed bundle intact.
 * Its private host requires a 0600 result file directly in the system temp directory.
 */
export async function requestBundledPermissions(bundle: string, signal: AbortSignal,
  launch = (args: string[], signal: AbortSignal) => run('/usr/bin/open', args, { signal }).then(() => undefined)) {
  const result = path.join(tmpdir(), `cua-driver-permissions-${randomUUID()}.json`)
  const file = await open(result, 'wx', 0o600)
  await file.close()

  try {
    await launch(['-n', '-W', '-g', path.resolve(bundle), '--args', '__permissions-host-request', '--result-file', result], signal)
    const payload = JSON.parse(await readFile(result, 'utf8'))

    if (!payload.structuredContent) { throw Error('computer_permission_host_invalid_result') }

    return payload.structuredContent as { accessibility: boolean; screen_recording: boolean }
  } finally { await rm(result, { force: true }) }
}
