import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Main-owned saved connection UUID. Tickets, credentials and local ports never
 * participate in identity or reach the renderer's persistent context keys. */
export function actionPanelConnectionId(directory: string, connection: { mode?: string; baseUrl: string; remoteHost?: string; remoteKind?: string }): string | undefined {
  try {
    let target = 'local'

    if (connection.mode === 'remote') {
      const url = new URL(connection.baseUrl)
      url.username = ''; url.password = ''; url.search = ''; url.hash = ''
      target = connection.remoteKind === 'ssh' && connection.remoteHost ? `ssh:${connection.remoteHost}` : url.href
    }

    const key = createHash('sha256').update(target).digest('hex')
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = path.join(directory, `${key}.id`)

    try {fs.writeFileSync(file, randomUUID(), { flag: 'wx', mode: 0o600 })} catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error}
    }

    const id = fs.readFileSync(file, 'utf8').trim()

    return /^[0-9a-f-]{36}$/u.test(id) ? id : undefined
  } catch {return undefined}
}
