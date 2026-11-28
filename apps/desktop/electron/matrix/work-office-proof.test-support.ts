import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function convertOffice(soffice: string, workspace: string, source: string, format: string): string {
  const output = mkdtempSync(path.join(workspace, 'office-proof-'))
  const profile = pathToFileURL(path.join(output, 'profile')).href

  execFileSync(soffice, [
    `-env:UserInstallation=${profile}`, '--headless', '--convert-to', format, '--outdir', output, source
  ], { timeout: 45_000 })

  return path.join(output, `${path.parse(source).name}.${format.split(':')[0]}`)
}
